# jr_proxy

HTTP proxy that re-encodes JRiver MCWS audio streams to FLAC or Opus via FFmpeg.

## Features

- Transcodes PCM/WAV to FLAC (lossless) or Opus (lossy).
- Disk caching for improved performance and seeking support (required for Opus/MP4).
- Lightweight: No external NPM dependencies.
- Docker ready.

## Docker Setup

### Using Docker Compose (Recommended)

1. Edit `docker-compose.yml` to set your `JRIVER_BASE` address.
2. Start the container:
   ```bash
   docker-compose up -d
   ```

### Using Docker CLI

1. Build the image:
   ```bash
   docker build -t jr-proxy .
   ```
2. Run the container:
   ```bash
   docker run -d \
     -p 8081:8081 \
     -e JRIVER_BASE="http://<YOUR_JRIVER_IP>:52199" \
     --name jr-proxy \
     jr-proxy
   ```

## Configuration

The following environment variables can be configured:

- `PORT`: Server port (default: `8081`).
- `JRIVER_BASE`: Base URL of your JRiver MCWS server (default: `http://127.0.0.1:52199` or `http://host.docker.internal:52199` in Docker).
- `FFMPEG`: Path to ffmpeg binary (default: `ffmpeg`).
- `FLAC_LEVEL`: FLAC compression level 0-8 (default: `5`).
- `BUFFER`: `disk` (cache everything) or `stream` (stream when possible) (default: `disk`).
- `CACHE_DIR`: Directory for transcode cache (default: `/cache` in Docker).
- `DEBUG`: Set to `1` to enable debug logging.

## Transcoding

The proxy detects transcoding requests based on JRiver's `getfile` parameters:

- `Conversion=opus` -> Transcoded to **Opus** (m4a).
  - Use `Quality=high` (160k), `normal` (96k), or `low` (64k).
- `Conversion=wav` -> JRiver MCWS server will return PCM stream.
- `Conversion=<any other value>` -> Transcoded to **FLAC**.
- No `Conversion` parameter -> Passed through without transcoding.
