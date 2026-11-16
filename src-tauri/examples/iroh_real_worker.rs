//! Real-worker check of the iroh byte pipe (`src/iroh_client.rs`), no Tauri app.
//!
//! Dials a running `sleap-connect serve` (iroh on) over iroh, exchanges the
//! protocol-v1 `hello` frames, then opens one of the worker's blobs on a
//! second stream and reads it front to back in ranges of at most
//! `MAX_BLOB_RANGE`, writing the bytes to a file (the caller compares its
//! sha256 with the blob's).
//!
//! cargo run --example iroh_real_worker -- <node_id> <out_file> [--sha256 H] [--relay URL] [--addr IP:PORT]... [--range N]
//!
//! `--range N` reads in ranges of N bytes (default MAX_BLOB_RANGE), to take many reads on one stream.
//!
//! Without `--sha256` only the hello exchange runs. The dial uses iroh's N0
//! preset (n0's relays and discovery), the same as the app.

use app_lib::iroh_client::{
    build_endpoint_addr, dial, open_blob_stream, read_blob_range, read_frame, write_frame,
    IrohDialTarget, MAX_BLOB_RANGE,
};
use iroh::endpoint::presets::N0;
use std::io::Write;

#[tokio::main]
async fn main() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let node_id = args.next().ok_or("usage: iroh_real_worker <node_id> <out_file> [--sha256 H] [--relay URL] [--addr IP:PORT]...")?;
    let out_file = args.next().ok_or("missing <out_file>")?;
    let (mut sha256, mut relay_url, mut direct_addrs, mut range) = (None, None, Vec::new(), MAX_BLOB_RANGE);
    while let Some(flag) = args.next() {
        let value = args.next().ok_or(format!("{flag} needs a value"))?;
        match flag.as_str() {
            "--sha256" => sha256 = Some(value),
            "--relay" => relay_url = Some(value),
            "--addr" => direct_addrs.push(value),
            "--range" => range = value.parse::<u64>().map_err(|e| e.to_string())?.clamp(1, MAX_BLOB_RANGE),
            other => return Err(format!("unknown flag {other}")),
        }
    }

    let target = IrohDialTarget {
        node_id,
        relay_url,
        direct_addrs: if direct_addrs.is_empty() { None } else { Some(direct_addrs) },
    };
    let started = std::time::Instant::now();
    let (endpoint, connection, mut send, mut recv) = dial(build_endpoint_addr(&target)?, N0).await?;
    println!("dialed in {:?}", started.elapsed());

    // protocol-v1 hello (the worker only needs a well-formed one to answer).
    let hello = serde_json::json!({
        "v": 1, "type": "hello", "proto": {"min": 1, "max": 1},
        "agent": {"name": "lucid-iroh-example", "version": "0", "platform": "test"},
        "node_id": endpoint.id().to_string(), "nonce": "example-nonce",
    });
    write_frame(&mut send, &hello.to_string()).await?;
    let reply = read_frame(&mut recv).await?.ok_or("worker closed before its hello")?;
    let reply: serde_json::Value = serde_json::from_str(&reply).map_err(|e| e.to_string())?;
    println!("worker hello: type={} node_id={} agent={}", reply["type"], reply["node_id"], reply["agent"]);
    assert_eq!(reply["type"], "hello");

    if let Some(sha256) = sha256 {
        let (opened, mut state) = open_blob_stream(connection.clone(), sha256).await?;
        println!("blob: size={} chunkSize={} chunks={}", opened.size, opened.chunk_size, opened.chunk_hashes.len());
        let mut out = std::fs::File::create(&out_file).map_err(|e| e.to_string())?;
        let mut offset = 0u64;
        let mut reads = 0;
        while offset < opened.size {
            let length = range.min(opened.size - offset);
            let bytes = read_blob_range(&mut state, offset, length).await?;
            if bytes.len() as u64 != length {
                return Err(format!("short read at {offset}: {} of {length}", bytes.len()));
            }
            out.write_all(&bytes).map_err(|e| e.to_string())?;
            offset += length;
            reads += 1;
        }
        println!("read {offset} bytes in {reads} ranges -> {out_file}");
        // A read over the cap must be refused without touching the stream.
        let over = read_blob_range(&mut state, 0, MAX_BLOB_RANGE + 1).await.unwrap_err();
        println!("over-cap read refused: {over}");
    }
    connection.close(0u32.into(), b"done");
    endpoint.close().await;
    println!("OK");
    Ok(())
}
