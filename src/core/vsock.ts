/**
 * Minimal VSOCK support via libc FFI.
 *
 * Only used for one-shot config reception at boot (VSOCK:7777).
 * All persistent bridging (inbound HTTP, outbound traffic forwarders)
 * is handled by the Rust traffic-forwarder binary.
 *
 * AF_VSOCK constants (Linux):
 *   AF_VSOCK        = 40
 *   VMADDR_CID_ANY  = 0xFFFFFFFF
 */

import { dlopen, FFIType, ptr } from "bun:ffi";

const AF_VSOCK = 40;
const SOCK_STREAM = 1;
const SOL_SOCKET = 1;
const SO_REUSEADDR = 2;
const SOCKADDR_VM_SIZE = 16;

const LIBC_SYMBOLS = {
  socket: { returns: FFIType.i32, args: [FFIType.i32, FFIType.i32, FFIType.i32] },
  bind: { returns: FFIType.i32, args: [FFIType.i32, FFIType.ptr, FFIType.i32] },
  listen: { returns: FFIType.i32, args: [FFIType.i32, FFIType.i32] },
  accept: { returns: FFIType.i32, args: [FFIType.i32, FFIType.ptr, FFIType.ptr] },
  close: { returns: FFIType.i32, args: [FFIType.i32] },
  read: { returns: FFIType.i64, args: [FFIType.i32, FFIType.ptr, FFIType.u64] },
  setsockopt: {
    returns: FFIType.i32,
    args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32],
  },
} as const;

// glibc = libc.so.6 (dev), musl = libc.so (enclave)
function openLibc() {
  try { return dlopen("libc.so.6", LIBC_SYMBOLS); } catch {}
  return dlopen("libc.so", LIBC_SYMBOLS);
}
const libc = openLibc();

function makeSockaddrVm(cid: number, port: number): Buffer {
  const buf = Buffer.alloc(SOCKADDR_VM_SIZE);
  buf.writeUInt16LE(AF_VSOCK, 0);
  buf.writeUInt16LE(0, 2);
  buf.writeUInt32LE(port, 4);
  buf.writeUInt32LE(cid, 8);
  buf.writeUInt32LE(0, 12);
  return buf;
}

/** Create a VSOCK socket, bind, and listen. Returns the raw fd. */
export function vsockListen(port: number, cid = 0xffffffff, backlog = 5): number {
  const fd = libc.symbols.socket(AF_VSOCK, SOCK_STREAM, 0) as number;
  if (fd < 0) throw new Error(`socket(AF_VSOCK) failed: fd=${fd}`);

  const one = Buffer.alloc(4);
  one.writeInt32LE(1);
  libc.symbols.setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, ptr(one), 4);

  const addr = makeSockaddrVm(cid, port);
  const rc = libc.symbols.bind(fd, ptr(addr), SOCKADDR_VM_SIZE) as number;
  if (rc < 0) {
    libc.symbols.close(fd);
    throw new Error(`bind(VSOCK:${port}) failed: rc=${rc}`);
  }

  const lrc = libc.symbols.listen(fd, backlog) as number;
  if (lrc < 0) {
    libc.symbols.close(fd);
    throw new Error(`listen(VSOCK:${port}) failed: rc=${lrc}`);
  }

  return fd;
}

/** Accept a connection (blocking). Returns the client fd. */
export function vsockAccept(listenFd: number): number {
  const peerAddr = Buffer.alloc(SOCKADDR_VM_SIZE);
  const addrLen = Buffer.alloc(4);
  addrLen.writeInt32LE(SOCKADDR_VM_SIZE);
  const clientFd = libc.symbols.accept(listenFd, ptr(peerAddr), ptr(addrLen)) as number;
  if (clientFd < 0) throw new Error(`accept() failed: fd=${clientFd}`);
  return clientFd;
}

/** Read all data from a fd until EOF (blocking). */
export function vsockReadAll(fd: number): Buffer {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(4096);
  for (;;) {
    const n = Number(libc.symbols.read(fd, ptr(buf), 4096));
    if (n <= 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks);
}

/** Close a fd. */
export function vsockClose(fd: number): void {
  libc.symbols.close(fd);
}
