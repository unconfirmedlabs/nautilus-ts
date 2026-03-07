//! Minimal NSM FFI for Bun/TypeScript.
//!
//! Exposes exactly what's needed to get attestation documents from
//! the Nitro Secure Module. Everything else (Ed25519, hashing, etc.)
//! is done in TypeScript via @noble libraries.

use std::ptr;

/// Request an attestation document bound to the given public key.
///
/// Returns a heap-allocated buffer with the attestation document bytes.
/// The caller must free it with `nsm_free(ptr, len)`.
///
/// `out_len` receives the length of the returned buffer.
/// Returns null on failure or if `pk_ptr` / `out_len` is null.
///
/// # Safety
/// `pk_ptr` must point to `pk_len` bytes. `out_len` must be a valid pointer.
#[no_mangle]
pub unsafe extern "C" fn nsm_get_attestation(
    pk_ptr: *const u8,
    pk_len: u32,
    out_len: *mut u32,
) -> *mut u8 {
    if pk_ptr.is_null() || out_len.is_null() {
        return ptr::null_mut();
    }

    let pk = std::slice::from_raw_parts(pk_ptr, pk_len as usize);

    let fd = nsm_api::driver::nsm_init();
    let request = nsm_api::api::Request::Attestation {
        user_data: None,
        nonce: None,
        public_key: Some(serde_bytes::ByteBuf::from(pk.to_vec())),
    };

    let response = nsm_api::driver::nsm_process_request(fd, request);
    nsm_api::driver::nsm_exit(fd);

    match response {
        nsm_api::api::Response::Attestation { document } => {
            *out_len = document.len() as u32;
            let boxed = document.into_boxed_slice();
            Box::into_raw(boxed) as *mut u8
        }
        _ => {
            *out_len = 0;
            ptr::null_mut()
        }
    }
}

/// Get 256 bytes of hardware random from the NSM.
///
/// # Safety
/// `out_ptr` must point to a buffer of at least 256 bytes.
/// Returns 0 on success, -1 on failure or if `out_ptr` is null.
#[no_mangle]
pub unsafe extern "C" fn nsm_get_random(out_ptr: *mut u8) -> i32 {
    if out_ptr.is_null() {
        return -1;
    }

    let fd = nsm_api::driver::nsm_init();
    let request = nsm_api::api::Request::GetRandom;
    let response = nsm_api::driver::nsm_process_request(fd, request);
    nsm_api::driver::nsm_exit(fd);

    match response {
        nsm_api::api::Response::GetRandom { random } => {
            let len = random.len().min(256);
            std::ptr::copy_nonoverlapping(random.as_ptr(), out_ptr, len);
            // Zero-fill remainder if less than 256 bytes
            if len < 256 {
                std::ptr::write_bytes(out_ptr.add(len), 0, 256 - len);
            }
            0
        }
        _ => -1,
    }
}

/// Free a buffer previously returned by `nsm_get_attestation`.
///
/// # Safety
/// `data` must be a pointer returned by `nsm_get_attestation` and `len` must
/// be the corresponding `out_len` value, or `data` must be null.
#[no_mangle]
pub unsafe extern "C" fn nsm_free(data: *mut u8, len: u32) {
    if !data.is_null() {
        let len = len as usize;
        drop(Box::from_raw(std::slice::from_raw_parts_mut(data, len)));
    }
}
