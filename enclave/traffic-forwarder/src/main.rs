//! Traffic forwarder for Nautilus enclave.
//!
//! Bridges TCP↔VSOCK connections inside a Nitro Enclave where there is no
//! network — only VSOCK to the parent EC2 instance.
//!
//! Two modes:
//!   1. **Inbound**: VSOCK listen → TCP connect to localhost (HTTP traffic to Bun)
//!   2. **Outbound**: TCP listen on loopback → VSOCK connect to parent (external services)
//!
//! The Bun process spawns this binary with a JSON config on stdin, then starts
//! its HTTP server. This binary also writes /etc/hosts so that DNS resolution
//! maps external hostnames to local loopback addresses.
//!
//! Usage:
//!   echo '<config json>' | traffic-forwarder

use std::io::Read;
use tokio::io;
use tokio::net::{TcpListener, TcpStream};
use tokio_vsock::{VsockAddr, VsockListener, VsockStream, VMADDR_CID_ANY};

const PARENT_CID: u32 = 3;

#[derive(serde::Deserialize)]
struct Config {
    /// VSOCK port for inbound HTTP traffic (bridged to TCP localhost:http_port).
    http_vsock_port: u32,
    /// TCP port where Bun.serve() listens.
    http_tcp_port: u16,
    /// External endpoints to forward.
    endpoints: Vec<Endpoint>,
}

#[derive(serde::Deserialize)]
struct Endpoint {
    /// Domain name (e.g. "fullnode.testnet.sui.io")
    host: String,
    /// VSOCK port on the parent VM that proxies to this host:443
    vsock_port: u32,
}

#[tokio::main]
async fn main() {
    // Read config from stdin
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).expect("failed to read config from stdin");
    let config: Config = serde_json::from_str(&input).expect("invalid config JSON");

    // Write /etc/hosts
    write_hosts(&config.endpoints);

    // Spawn inbound bridge: VSOCK → TCP (HTTP traffic to Bun)
    let http_tcp_port = config.http_tcp_port;
    let http_vsock_port = config.http_vsock_port;
    tokio::spawn(async move {
        inbound_bridge(http_vsock_port, http_tcp_port).await;
    });

    // Spawn outbound forwarders: TCP → VSOCK (external services)
    let mut handles = Vec::new();
    for (i, ep) in config.endpoints.iter().enumerate() {
        let ip = format!("127.0.0.{}", 64 + i);
        let vsock_port = ep.vsock_port;
        eprintln!("[traffic] {} → {}:443 → VSOCK:{}:{}", ep.host, ip, PARENT_CID, vsock_port);

        let handle = tokio::spawn(async move {
            outbound_forwarder(&ip, vsock_port).await;
        });
        handles.push(handle);
    }

    eprintln!("[traffic] ready");

    // Block forever — all bridges run as spawned tasks
    tokio::signal::ctrl_c().await.ok();
}

/// Write /etc/hosts mapping endpoint hostnames to loopback addresses.
fn write_hosts(endpoints: &[Endpoint]) {
    let mut lines = vec!["127.0.0.1   localhost".to_string()];
    for (i, ep) in endpoints.iter().enumerate() {
        lines.push(format!("127.0.0.{}   {}", 64 + i, ep.host));
    }
    let content = lines.join("\n") + "\n";
    if let Err(e) = std::fs::write("/etc/hosts", &content) {
        eprintln!("[traffic] warning: could not write /etc/hosts: {e}");
    }
}

/// Inbound bridge: accept VSOCK connections, forward each to TCP localhost.
async fn inbound_bridge(vsock_port: u32, tcp_port: u16) {
    let mut listener = VsockListener::bind(VsockAddr::new(VMADDR_CID_ANY, vsock_port))
        .expect("failed to bind VSOCK listener");
    eprintln!("[traffic] inbound VSOCK:{vsock_port} → TCP:127.0.0.1:{tcp_port}");

    loop {
        match listener.accept().await {
            Ok((vsock_stream, _addr)) => {
                tokio::spawn(async move {
                    if let Err(e) = bridge_inbound(vsock_stream, tcp_port).await {
                        eprintln!("[traffic] inbound bridge error: {e}");
                    }
                });
            }
            Err(e) => {
                eprintln!("[traffic] inbound accept error: {e}");
            }
        }
    }
}

async fn bridge_inbound(vsock_stream: VsockStream, tcp_port: u16) -> io::Result<()> {
    let tcp_stream = TcpStream::connect(format!("127.0.0.1:{tcp_port}")).await?;
    let (mut vsock_r, mut vsock_w) = io::split(vsock_stream);
    let (mut tcp_r, mut tcp_w) = io::split(tcp_stream);

    let c2s = io::copy(&mut vsock_r, &mut tcp_w);
    let s2c = io::copy(&mut tcp_r, &mut vsock_w);

    tokio::select! {
        r = c2s => { r?; }
        r = s2c => { r?; }
    }
    Ok(())
}

/// Outbound forwarder: listen on a loopback IP:443, forward each to VSOCK parent.
async fn outbound_forwarder(local_ip: &str, vsock_port: u32) {
    let addr = format!("{local_ip}:443");
    let listener = TcpListener::bind(&addr).await
        .unwrap_or_else(|e| panic!("failed to bind {addr}: {e}"));

    loop {
        match listener.accept().await {
            Ok((tcp_stream, _addr)) => {
                tokio::spawn(async move {
                    if let Err(e) = bridge_outbound(tcp_stream, vsock_port).await {
                        eprintln!("[traffic] outbound bridge error: {e}");
                    }
                });
            }
            Err(e) => {
                eprintln!("[traffic] outbound accept error: {e}");
            }
        }
    }
}

async fn bridge_outbound(tcp_stream: TcpStream, vsock_port: u32) -> io::Result<()> {
    let vsock_stream = VsockStream::connect(VsockAddr::new(PARENT_CID, vsock_port)).await?;
    let (mut tcp_r, mut tcp_w) = io::split(tcp_stream);
    let (mut vsock_r, mut vsock_w) = io::split(vsock_stream);

    let c2s = io::copy(&mut tcp_r, &mut vsock_w);
    let s2c = io::copy(&mut vsock_r, &mut tcp_w);

    tokio::select! {
        r = c2s => { r?; }
        r = s2c => { r?; }
    }
    Ok(())
}
