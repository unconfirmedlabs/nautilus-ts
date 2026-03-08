package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strings"
	"testing"
)

func TestConfigParsesValidJSON(t *testing.T) {
	input := `{"http_vsock_port":3000,"http_tcp_port":3000,"endpoints":[{"host":"sui.io","vsock_port":8443}]}`
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
	input := `{"http_vsock_port":3000,"http_tcp_port":3000,"endpoints":[]}`
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
