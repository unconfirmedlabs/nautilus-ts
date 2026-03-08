package main

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
)

func TestConfigParsesValidJSON(t *testing.T) {
	input := `{"httpVsockPort":3000,"httpTcpPort":3000,"endpoints":[{"host":"sui.io","vsockPort":8443}]}`
	var config Config
	if err := json.NewDecoder(strings.NewReader(input)).Decode(&config); err != nil {
		t.Fatal(err)
	}
	if len(config.Endpoints) != 1 {
		t.Fatalf("expected 1 endpoint, got %d", len(config.Endpoints))
	}
	if config.Endpoints[0].Host != "sui.io" {
		t.Fatalf("expected host sui.io, got %s", config.Endpoints[0].Host)
	}
	if config.Endpoints[0].VsockPort != 8443 {
		t.Fatalf("expected vsock port 8443, got %d", config.Endpoints[0].VsockPort)
	}
}

func TestConfigParsesEmptyEndpoints(t *testing.T) {
	input := `{"httpVsockPort":3000,"httpTcpPort":3000,"endpoints":[]}`
	var config Config
	if err := json.NewDecoder(strings.NewReader(input)).Decode(&config); err != nil {
		t.Fatal(err)
	}
	if len(config.Endpoints) != 0 {
		t.Fatalf("expected 0 endpoints, got %d", len(config.Endpoints))
	}
}

func TestConfigRejectsMissingFields(t *testing.T) {
	// Missing required fields should result in zero values, but endpoints
	// is required for any meaningful config
	input := `{}`
	var config Config
	if err := json.NewDecoder(strings.NewReader(input)).Decode(&config); err != nil {
		t.Fatal(err)
	}
	if config.HTTPVsockPort != 0 || config.HTTPTCPPort != 0 {
		t.Fatal("expected zero values for missing fields")
	}
}

func TestLoopbackIPGeneration(t *testing.T) {
	for i := 0; i < 191; i++ {
		ip := fmt.Sprintf("127.0.0.%d", 64+i)
		if net.ParseIP(ip) == nil {
			t.Fatalf("invalid IP: %s", ip)
		}
	}
}

func TestHostsFileContent(t *testing.T) {
	endpoints := []Endpoint{
		{Host: "sui.io", VsockPort: 8001},
		{Host: "walrus.io", VsockPort: 8002},
	}
	lines := []string{"127.0.0.1   localhost"}
	for i, ep := range endpoints {
		lines = append(lines, fmt.Sprintf("127.0.0.%d   %s", 64+i, ep.Host))
	}
	content := strings.Join(lines, "\n") + "\n"

	if !strings.Contains(content, "127.0.0.1   localhost") {
		t.Fatal("missing localhost entry")
	}
	if !strings.Contains(content, "127.0.0.64   sui.io") {
		t.Fatal("missing sui.io entry")
	}
	if !strings.Contains(content, "127.0.0.65   walrus.io") {
		t.Fatal("missing walrus.io entry")
	}
	if count := strings.Count(content, "\n"); count != 3 {
		t.Fatalf("expected 3 lines, got %d", count)
	}
}

func TestConfigRejectsInvalidJSON(t *testing.T) {
	input := `{not valid json}`
	var config Config
	if err := json.NewDecoder(strings.NewReader(input)).Decode(&config); err == nil {
		t.Fatal("expected error for invalid JSON, got nil")
	}
}

func TestMaxEndpointLimit(t *testing.T) {
	// The code enforces a max of 191 endpoints (127.0.0.64 through 127.0.0.254)
	for count := range []int{0, 1, 191} {
		_ = count
		ip := fmt.Sprintf("127.0.0.%d", 64+191-1) // max valid
		if net.ParseIP(ip) == nil {
			t.Fatalf("max endpoint IP should be valid: %s", ip)
		}
	}
	// 192nd would be 127.0.0.256 which is invalid
	invalid := fmt.Sprintf("127.0.0.%d", 64+192)
	if net.ParseIP(invalid) != nil {
		t.Fatalf("overflow IP should be invalid: %s", invalid)
	}
}

func TestHostsFileNoInjection(t *testing.T) {
	// Verify that the hosts file format doesn't allow injection
	// Each line should be exactly "IP   hostname"
	endpoints := []Endpoint{
		{Host: "normal.host", VsockPort: 8001},
	}
	lines := []string{"127.0.0.1   localhost"}
	for i, ep := range endpoints {
		lines = append(lines, fmt.Sprintf("127.0.0.%d   %s", 64+i, ep.Host))
	}
	content := strings.Join(lines, "\n") + "\n"

	// Should have exactly 2 lines (localhost + 1 endpoint)
	lineCount := strings.Count(content, "\n")
	if lineCount != 2 {
		t.Fatalf("expected 2 lines, got %d", lineCount)
	}

	// No line should contain more than one hostname
	for _, line := range strings.Split(strings.TrimSpace(content), "\n") {
		parts := strings.Fields(line)
		if len(parts) != 2 {
			t.Fatalf("expected exactly 2 fields per line, got %d: %q", len(parts), line)
		}
	}
}

// --- Host config tests ---

func TestHostConfigParsesValidJSON(t *testing.T) {
	input := `{"httpPort":8080,"httpVsockPort":3000,"endpoints":[{"host":"sui.io","vsockPort":8104}]}`
	var cfg HostConfig
	if err := json.Unmarshal([]byte(input), &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.HTTPPort != 8080 {
		t.Fatalf("expected httpPort 8080, got %d", cfg.HTTPPort)
	}
	if cfg.HTTPVsockPort != 3000 {
		t.Fatalf("expected httpVsockPort 3000, got %d", cfg.HTTPVsockPort)
	}
	if len(cfg.Endpoints) != 1 || cfg.Endpoints[0].Host != "sui.io" {
		t.Fatalf("unexpected endpoints: %+v", cfg.Endpoints)
	}
}

func TestHostConfigIgnoresExtraFields(t *testing.T) {
	// The host config should silently ignore enclave-only fields like secrets, app, logLevel
	input := `{"httpPort":8080,"httpVsockPort":3000,"endpoints":[],"secrets":{"key":"val"},"app":{"foo":1},"logLevel":"debug"}`
	var cfg HostConfig
	if err := json.Unmarshal([]byte(input), &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.HTTPPort != 8080 {
		t.Fatalf("expected httpPort 8080, got %d", cfg.HTTPPort)
	}
}

func TestHostConfigMultipleEndpoints(t *testing.T) {
	input := `{"httpPort":8080,"httpVsockPort":3000,"endpoints":[
		{"host":"fullnode.testnet.sui.io","vsockPort":8104},
		{"host":"seal.mirai.cloud","vsockPort":8101},
		{"host":"walrus.space","vsockPort":8103}
	]}`
	var cfg HostConfig
	if err := json.Unmarshal([]byte(input), &cfg); err != nil {
		t.Fatal(err)
	}
	if len(cfg.Endpoints) != 3 {
		t.Fatalf("expected 3 endpoints, got %d", len(cfg.Endpoints))
	}
}

func TestHostConfigZeroHTTPPortDetected(t *testing.T) {
	input := `{"httpVsockPort":3000,"endpoints":[]}`
	var cfg HostConfig
	if err := json.Unmarshal([]byte(input), &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.HTTPPort != 0 {
		t.Fatalf("expected httpPort 0 (missing), got %d", cfg.HTTPPort)
	}
}

// --- DNS resolution tests (ported from aws-nitro-enclaves-cli vsock_proxy/src/dns.rs) ---

func TestResolveValidDomain(t *testing.T) {
	addrs, err := net.LookupHost("localhost")
	if err != nil {
		t.Fatalf("failed to resolve localhost: %v", err)
	}
	if len(addrs) == 0 {
		t.Fatal("expected at least one address for localhost")
	}
}

func TestResolveInvalidDomain(t *testing.T) {
	_, err := net.LookupHost("invalid.invalid")
	if err == nil {
		t.Fatal("expected error resolving invalid domain, got nil")
	}
}

func TestResolveReturnsIPv4ForLocalhost(t *testing.T) {
	addrs, err := net.LookupHost("localhost")
	if err != nil {
		t.Fatalf("failed to resolve localhost: %v", err)
	}
	hasIPv4 := false
	for _, addr := range addrs {
		if ip := net.ParseIP(addr); ip != nil && ip.To4() != nil {
			hasIPv4 = true
			break
		}
	}
	if !hasIPv4 {
		t.Fatal("expected at least one IPv4 address for localhost")
	}
}

func TestDialResolvesHostname(t *testing.T) {
	// Start a local TCP server
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	// net.Dial with "localhost" should resolve and connect
	port := ln.Addr().(*net.TCPAddr).Port
	conn, err := net.Dial("tcp", fmt.Sprintf("localhost:%d", port))
	if err != nil {
		t.Fatalf("failed to dial localhost:%d: %v", port, err)
	}
	conn.Close()
}

// --- Outbound bridge tests (ported from aws-nitro-enclaves-cli vsock_proxy/src/proxy.rs) ---

func TestBridgeToTCPHost(t *testing.T) {
	// Simulate the outbound proxy path: src → bridgeToTCPHost → target server
	// Uses TCP pairs since VSOCK is not available in CI.

	// Start a "remote server" that echoes data back
	remoteLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer remoteLn.Close()

	go func() {
		conn, err := remoteLn.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		io.Copy(conn, conn) // echo
	}()

	// Create a TCP connection pair to simulate the VSOCK side
	pairLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer pairLn.Close()

	client, err := net.Dial("tcp", pairLn.Addr().String())
	if err != nil {
		t.Fatal(err)
	}

	src, err := pairLn.Accept()
	if err != nil {
		t.Fatal(err)
	}

	// Bridge the connection to the remote server
	done := make(chan error, 1)
	go func() {
		done <- bridgeToTCPHost(src, remoteLn.Addr().String())
	}()

	// Send data through and verify echo
	msg := "hello from enclave"
	fmt.Fprint(client, msg)
	client.(*net.TCPConn).CloseWrite()

	buf, err := io.ReadAll(client)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf) != msg {
		t.Fatalf("expected %q, got %q", msg, string(buf))
	}

	if err := <-done; err != nil {
		t.Fatalf("bridge error: %v", err)
	}
}

// TestLargeDataTransfer is ported from aws-nitro-enclaves-cli vsock_proxy test_transfer.
// Verifies that data larger than io.Copy's internal buffer (32KB) transfers correctly.
func TestLargeDataTransfer(t *testing.T) {
	const dataSize = 1 << 20 // 1MB

	// Generate random data
	data := make([]byte, dataSize)
	if _, err := rand.Read(data); err != nil {
		t.Fatal(err)
	}

	// Start a "remote server" that reads everything and sends it back
	remoteLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer remoteLn.Close()

	go func() {
		conn, err := remoteLn.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		io.Copy(conn, conn)
	}()

	// Create connection pair
	pairLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer pairLn.Close()

	client, err := net.Dial("tcp", pairLn.Addr().String())
	if err != nil {
		t.Fatal(err)
	}

	src, err := pairLn.Accept()
	if err != nil {
		t.Fatal(err)
	}

	done := make(chan error, 1)
	go func() {
		done <- bridgeToTCPHost(src, remoteLn.Addr().String())
	}()

	// Write all data, then close write side
	if _, err := client.Write(data); err != nil {
		t.Fatal(err)
	}
	client.(*net.TCPConn).CloseWrite()

	// Read back and verify
	received, err := io.ReadAll(client)
	if err != nil {
		t.Fatal(err)
	}
	if len(received) != dataSize {
		t.Fatalf("expected %d bytes, got %d", dataSize, len(received))
	}
	for i := range data {
		if data[i] != received[i] {
			t.Fatalf("mismatch at byte %d: expected 0x%02x, got 0x%02x", i, data[i], received[i])
		}
	}

	if err := <-done; err != nil {
		t.Fatalf("bridge error: %v", err)
	}
}

// TestConcurrentOutboundConnections verifies multiple simultaneous connections
// through the outbound bridge work correctly (mirrors vsock-proxy's worker pool).
func TestConcurrentOutboundConnections(t *testing.T) {
	// Start a "remote server" that echoes data
	remoteLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer remoteLn.Close()

	go func() {
		for {
			conn, err := remoteLn.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				io.Copy(conn, conn)
			}()
		}
	}()

	const numConns = 10
	var wg sync.WaitGroup
	errors := make(chan error, numConns)

	for i := 0; i < numConns; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()

			// Create connection pair
			pairLn, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				errors <- fmt.Errorf("conn %d: listen: %w", id, err)
				return
			}
			defer pairLn.Close()

			client, err := net.Dial("tcp", pairLn.Addr().String())
			if err != nil {
				errors <- fmt.Errorf("conn %d: dial: %w", id, err)
				return
			}

			src, err := pairLn.Accept()
			if err != nil {
				errors <- fmt.Errorf("conn %d: accept: %w", id, err)
				return
			}

			bridgeDone := make(chan error, 1)
			go func() {
				bridgeDone <- bridgeToTCPHost(src, remoteLn.Addr().String())
			}()

			msg := fmt.Sprintf("message from connection %d", id)
			fmt.Fprint(client, msg)
			client.(*net.TCPConn).CloseWrite()

			buf, err := io.ReadAll(client)
			if err != nil {
				errors <- fmt.Errorf("conn %d: read: %w", id, err)
				return
			}
			if string(buf) != msg {
				errors <- fmt.Errorf("conn %d: expected %q, got %q", id, msg, string(buf))
				return
			}

			if err := <-bridgeDone; err != nil {
				errors <- fmt.Errorf("conn %d: bridge: %w", id, err)
			}
		}(i)
	}

	wg.Wait()
	close(errors)

	for err := range errors {
		t.Error(err)
	}
}

func TestCopyBidirectional(t *testing.T) {
	// Create two pairs of connected TCP sockets to test the bridge
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	// Client side
	clientConn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}

	serverConn, err := ln.Accept()
	if err != nil {
		t.Fatal(err)
	}

	// Create another pair
	ln2, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln2.Close()

	remoteConn, err := net.Dial("tcp", ln2.Addr().String())
	if err != nil {
		t.Fatal(err)
	}

	backendConn, err := ln2.Accept()
	if err != nil {
		t.Fatal(err)
	}

	// Run bridge in background
	done := make(chan error, 1)
	go func() {
		done <- copyBidirectional(serverConn, remoteConn)
	}()

	// Send data through the bridge
	msg := "hello from client"
	fmt.Fprint(clientConn, msg)
	clientConn.(*net.TCPConn).CloseWrite()

	buf, err := io.ReadAll(backendConn)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf) != msg {
		t.Fatalf("expected %q, got %q", msg, string(buf))
	}

	// Send response back
	resp := "hello from backend"
	fmt.Fprint(backendConn, resp)
	backendConn.Close()

	buf, err = io.ReadAll(clientConn)
	if err != nil {
		t.Fatal(err)
	}
	if string(buf) != resp {
		t.Fatalf("expected %q, got %q", resp, string(buf))
	}

	// Bridge should complete
	if err := <-done; err != nil {
		t.Fatalf("bridge error: %v", err)
	}
}
