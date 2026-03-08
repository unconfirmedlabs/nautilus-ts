// Argonaut — companion binary for Nautilus-TS enclaves.
//
// Handles VSOCK↔TCP bridging, config delivery, and NSM attestation.
// Named "arGOnaut" as a nod to Go, and Nautilus-adjacent.
//
// Modes:
//
//	argonaut host <cid> <config-file>
//	    Read JSON config, send it to the enclave via VSOCK:7777, then:
//	    1. Inbound:  TCP listen → VSOCK connect (HTTP into the enclave)
//	    2. Outbound: VSOCK listen → TCP connect (enclave reaching external services)
//	    Replaces both the separate config-send step and AWS vsock-proxy.
//
//	argonaut enclave
//	    Read JSON config from stdin, then:
//	    1. Write /etc/hosts for endpoint hostname resolution
//	    2. Inbound:  VSOCK listen → TCP connect to localhost (HTTP to Bun)
//	    3. Outbound: TCP listen on loopback → VSOCK connect to parent
//	    Runs inside the Nitro Enclave where there is no network.
//
//	argonaut config send <cid> <vsock-port>
//	    Read stdin and send it to VSOCK:<cid>:<port>. Low-level utility
//	    for debugging; normal usage goes through "argonaut host".
//
//	argonaut config recv <vsock-port>
//	    Listen on VSOCK:<port>, accept one connection, read all data,
//	    and write it to stdout. Used inside the enclave at boot.
//
//	argonaut nsm
//	    NSM proxy: stdin/stdout line protocol for attestation and RNG.
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"

	"github.com/mdlayher/vsock"
)

const parentCID = 3

func main() {
	if len(os.Args) < 2 {
		usage()
	}

	switch os.Args[1] {
	case "host":
		hostMode()
	case "enclave":
		enclaveMode()
	case "config":
		configMode()
	case "nsm":
		nsmMode()
	default:
		usage()
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, "Usage:\n")
	fmt.Fprintf(os.Stderr, "  %s host <cid> <config-file>\n", os.Args[0])
	fmt.Fprintf(os.Stderr, "  %s enclave  (reads JSON config from stdin)\n", os.Args[0])
	fmt.Fprintf(os.Stderr, "  %s config send <cid> <vsock-port>  (send stdin to VSOCK)\n", os.Args[0])
	fmt.Fprintf(os.Stderr, "  %s config recv <vsock-port>        (receive from VSOCK to stdout)\n", os.Args[0])
	fmt.Fprintf(os.Stderr, "  %s nsm                             (NSM proxy: stdin/stdout line protocol)\n", os.Args[0])
	os.Exit(1)
}

// --- Host mode: config delivery + inbound/outbound bridges ---

// HostConfig is the config shape used by the host side.
// Extra fields (secrets, app, logLevel) are ignored — the raw JSON is
// sent verbatim to the enclave, which parses them separately.
type HostConfig struct {
	HTTPPort      uint16     `json:"httpPort"`
	HTTPVsockPort uint32     `json:"httpVsockPort"`
	Endpoints     []Endpoint `json:"endpoints"`
}

const configVsockPort uint32 = 7777

func hostMode() {
	if len(os.Args) != 4 {
		usage()
	}

	cid, err := strconv.ParseUint(os.Args[2], 10, 32)
	if err != nil {
		log.Fatalf("invalid enclave CID: %s", os.Args[2])
	}

	configPath := os.Args[3]
	rawConfig, err := os.ReadFile(configPath)
	if err != nil {
		log.Fatalf("failed to read config file: %v", err)
	}

	var hostCfg HostConfig
	if err := json.Unmarshal(rawConfig, &hostCfg); err != nil {
		log.Fatalf("invalid config JSON: %v", err)
	}
	if hostCfg.HTTPPort == 0 {
		log.Fatalf("httpPort is required in config")
	}
	if hostCfg.HTTPVsockPort == 0 {
		log.Fatalf("httpVsockPort is required in config")
	}

	// Send config to enclave via VSOCK:7777
	sendConfigVSOCK(uint32(cid), configVsockPort, rawConfig)

	// Start all bridges
	var wg sync.WaitGroup

	// Inbound: TCP:<httpPort> → VSOCK:<cid>:<httpVsockPort>
	wg.Add(1)
	go func() {
		defer wg.Done()
		hostInboundBridge(hostCfg.HTTPPort, uint32(cid), hostCfg.HTTPVsockPort)
	}()

	// Outbound: for each endpoint, VSOCK:<vsockPort> → TCP:<host>:443
	for _, ep := range hostCfg.Endpoints {
		wg.Add(1)
		go func(ep Endpoint) {
			defer wg.Done()
			hostOutboundBridge(ep)
		}(ep)
	}

	log.Println("[host] all bridges started")
	wg.Wait()
	log.Println("[host] bridge exited unexpectedly")
	os.Exit(1)
}

// sendConfigVSOCK sends raw bytes to a VSOCK endpoint.
func sendConfigVSOCK(cid, port uint32, data []byte) {
	conn, err := vsock.Dial(cid, port, nil)
	if err != nil {
		log.Fatalf("[host] VSOCK dial %d:%d for config: %v", cid, port, err)
	}
	if _, err := conn.Write(data); err != nil {
		conn.Close()
		log.Fatalf("[host] config write: %v", err)
	}
	conn.Close()
	log.Printf("[host] config sent (%d bytes) to CID %d via VSOCK:%d", len(data), cid, port)
}

func hostInboundBridge(tcpPort uint16, cid, vsockPort uint32) {
	ln, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", tcpPort))
	if err != nil {
		log.Fatalf("[host] failed to listen on TCP:%d: %v", tcpPort, err)
	}
	log.Printf("[host] inbound TCP:%d → VSOCK:%d:%d", tcpPort, cid, vsockPort)

	for {
		tcp, err := ln.Accept()
		if err != nil {
			log.Printf("[host] inbound accept error: %v", err)
			continue
		}
		go func() {
			if err := bridgeToVSOCK(tcp, cid, vsockPort); err != nil {
				log.Printf("[host] inbound bridge error: %v", err)
			}
		}()
	}
}

// hostOutboundBridge listens on a VSOCK port for connections from the enclave
// and bridges them to the endpoint's TCP host:443. This replaces AWS vsock-proxy.
func hostOutboundBridge(ep Endpoint) {
	ln, err := vsock.Listen(ep.VsockPort, nil)
	if err != nil {
		log.Fatalf("[host] failed to listen on VSOCK:%d for %s: %v", ep.VsockPort, ep.Host, err)
	}

	target := fmt.Sprintf("%s:443", ep.Host)
	log.Printf("[host] outbound VSOCK:%d → TCP:%s", ep.VsockPort, target)

	for {
		vc, err := ln.Accept()
		if err != nil {
			log.Printf("[host] outbound accept error (VSOCK:%d): %v", ep.VsockPort, err)
			continue
		}
		go func() {
			if err := bridgeToTCPHost(vc, target); err != nil {
				log.Printf("[host] outbound bridge error (%s): %v", target, err)
			}
		}()
	}
}

// bridgeToTCPHost bridges a connection to a remote TCP host (DNS resolved at dial time).
func bridgeToTCPHost(src net.Conn, target string) error {
	defer src.Close()

	tcp, err := net.Dial("tcp", target)
	if err != nil {
		return fmt.Errorf("TCP dial %s: %w", target, err)
	}
	defer tcp.Close()

	return copyBidirectional(src, tcp)
}

func bridgeToVSOCK(src net.Conn, cid, port uint32) error {
	defer src.Close()

	vc, err := vsock.Dial(cid, port, nil)
	if err != nil {
		return fmt.Errorf("VSOCK dial %d:%d: %w", cid, port, err)
	}
	defer vc.Close()

	return copyBidirectional(src, vc)
}

// --- Enclave mode: JSON config from stdin, multiple bridges ---

type Config struct {
	HTTPVsockPort uint32     `json:"httpVsockPort"`
	HTTPTCPPort   uint16     `json:"httpTcpPort"`
	Endpoints     []Endpoint `json:"endpoints"`
}

type Endpoint struct {
	Host      string `json:"host"`
	VsockPort uint32 `json:"vsockPort"`
}

func enclaveMode() {
	var config Config
	if err := json.NewDecoder(os.Stdin).Decode(&config); err != nil {
		log.Fatalf("invalid config JSON: %v", err)
	}

	if len(config.Endpoints) > 191 {
		log.Fatalf("too many endpoints (max 191, got %d)", len(config.Endpoints))
	}

	writeHosts(config.Endpoints)

	// All bridges run forever — if any returns, something failed.
	var wg sync.WaitGroup

	// Inbound: VSOCK listen → TCP connect (HTTP traffic to Bun)
	wg.Add(1)
	go func() {
		defer wg.Done()
		inboundBridge(config.HTTPVsockPort, config.HTTPTCPPort)
	}()

	// Outbound: TCP listen → VSOCK connect (external services)
	for i, ep := range config.Endpoints {
		ip := fmt.Sprintf("127.0.0.%d", 64+i)
		log.Printf("[traffic] %s → %s:443 → VSOCK:%d:%d", ep.Host, ip, parentCID, ep.VsockPort)

		wg.Add(1)
		go func(localIP string, vsockPort uint32) {
			defer wg.Done()
			outboundProxy(localIP, vsockPort)
		}(ip, ep.VsockPort)
	}

	log.Println("[traffic] ready")
	wg.Wait()
	log.Println("[traffic] bridge exited unexpectedly")
	os.Exit(1)
}

func writeHosts(endpoints []Endpoint) {
	lines := []string{"127.0.0.1   localhost"}
	for i, ep := range endpoints {
		lines = append(lines, fmt.Sprintf("127.0.0.%d   %s", 64+i, ep.Host))
	}
	content := strings.Join(lines, "\n") + "\n"
	if err := os.WriteFile("/etc/hosts", []byte(content), 0644); err != nil {
		log.Printf("[traffic] warning: could not write /etc/hosts: %v", err)
	}
}

func inboundBridge(vsockPort uint32, tcpPort uint16) {
	ln, err := vsock.Listen(vsockPort, nil)
	if err != nil {
		log.Fatalf("[traffic] failed to bind VSOCK:%d: %v", vsockPort, err)
	}
	log.Printf("[traffic] inbound VSOCK:%d → TCP:127.0.0.1:%d", vsockPort, tcpPort)

	for {
		vc, err := ln.Accept()
		if err != nil {
			log.Printf("[traffic] inbound accept error: %v", err)
			continue
		}
		go func() {
			if err := bridgeToTCP(vc, tcpPort); err != nil {
				log.Printf("[traffic] inbound bridge error: %v", err)
			}
		}()
	}
}

func bridgeToTCP(src net.Conn, tcpPort uint16) error {
	defer src.Close()

	tcp, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", tcpPort))
	if err != nil {
		return fmt.Errorf("TCP dial 127.0.0.1:%d: %w", tcpPort, err)
	}
	defer tcp.Close()

	return copyBidirectional(src, tcp)
}

func outboundProxy(localIP string, vsockPort uint32) {
	addr := fmt.Sprintf("%s:443", localIP)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("[traffic] failed to bind %s: %v", addr, err)
	}

	for {
		tcp, err := ln.Accept()
		if err != nil {
			log.Printf("[traffic] outbound accept error: %v", err)
			continue
		}
		go func() {
			if err := bridgeToVSOCK(tcp, parentCID, vsockPort); err != nil {
				log.Printf("[traffic] outbound bridge error: %v", err)
			}
		}()
	}
}

// --- Config mode: one-shot VSOCK send/recv ---

func configMode() {
	if len(os.Args) < 4 {
		usage()
	}

	switch os.Args[2] {
	case "send":
		configSend()
	case "recv":
		configRecv()
	default:
		usage()
	}
}

func configSend() {
	if len(os.Args) != 5 {
		usage()
	}

	cid, err := strconv.ParseUint(os.Args[3], 10, 32)
	if err != nil {
		log.Fatalf("invalid CID: %s", os.Args[3])
	}
	port, err := strconv.ParseUint(os.Args[4], 10, 32)
	if err != nil {
		log.Fatalf("invalid VSOCK port: %s", os.Args[4])
	}

	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		log.Fatalf("failed to read stdin: %v", err)
	}

	sendConfigVSOCK(uint32(cid), uint32(port), data)
}

func configRecv() {
	if len(os.Args) != 4 {
		usage()
	}

	port, err := strconv.ParseUint(os.Args[3], 10, 32)
	if err != nil {
		log.Fatalf("invalid VSOCK port: %s", os.Args[3])
	}

	ln, err := vsock.Listen(uint32(port), nil)
	if err != nil {
		log.Fatalf("VSOCK listen :%d: %v", port, err)
	}

	conn, err := ln.Accept()
	if err != nil {
		log.Fatalf("VSOCK accept: %v", err)
	}
	ln.Close()

	if _, err := io.Copy(os.Stdout, conn); err != nil {
		conn.Close()
		log.Fatalf("VSOCK read: %v", err)
	}
	conn.Close()
}

// --- Shared bidirectional copy with proper half-close ---

func copyBidirectional(a, b net.Conn) error {
	done := make(chan error, 2)

	go func() {
		_, err := io.Copy(b, a)
		closeWrite(b)
		done <- err
	}()

	go func() {
		_, err := io.Copy(a, b)
		closeWrite(a)
		done <- err
	}()

	// Wait for both directions
	err1 := <-done
	err2 := <-done

	if err1 != nil {
		return err1
	}
	return err2
}

// closeWrite calls CloseWrite on connections that support it (TCP and VSOCK).
func closeWrite(c net.Conn) {
	type halfCloser interface {
		CloseWrite() error
	}
	if hc, ok := c.(halfCloser); ok {
		hc.CloseWrite()
	}
}
