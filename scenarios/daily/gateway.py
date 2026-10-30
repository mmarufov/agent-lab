"""Publish Daily's API to the Mac without giving Daily a route out.

Docker drops published ports for containers attached only to an internal
network. This forwarder runs on both the internal network and an ordinary edge
network, accepts connections on the published port, and copies bytes to
daily-api unchanged. It resolves the target on every connection, so a recreated
daily-api container is picked up without restarting the gateway.

Usage: python gateway.py <listen-host:port> <target-host:port>
"""
import asyncio
import logging
import signal
import sys

CONNECT_TIMEOUT_SECONDS = 5

logging.basicConfig(level=logging.INFO, format="%(levelname)s agent_lab.gateway: %(message)s")
logger = logging.getLogger("agent_lab.gateway")


def address(value):
    host, _, port = value.rpartition(":")
    return host, int(port)


async def relay(reader, writer, source):
    """Copy one direction until EOF, then half-close so the peer sees the end."""
    try:
        while chunk := await reader.read(65536):
            writer.write(chunk)
            await writer.drain()
        if writer.can_write_eof():
            writer.write_eof()
    except OSError:
        # A reset on either side ends both directions immediately.
        writer.transport.abort()
        source.transport.abort()


async def forward(target, client_reader, client_writer):
    try:
        upstream_reader, upstream_writer = await asyncio.wait_for(
            asyncio.open_connection(*target), CONNECT_TIMEOUT_SECONDS
        )
    except (OSError, asyncio.TimeoutError) as error:
        logger.warning("cannot reach %s:%s (%s)", *target, str(error) or type(error).__name__)
        client_writer.transport.abort()
        return
    try:
        await asyncio.gather(
            relay(client_reader, upstream_writer, client_writer),
            relay(upstream_reader, client_writer, upstream_writer),
        )
    finally:
        upstream_writer.close()
        client_writer.close()


async def main(listen, target):
    server = await asyncio.start_server(
        lambda reader, writer: forward(target, reader, writer), *listen, reuse_address=True
    )
    stopping = asyncio.Event()
    for signum in (signal.SIGTERM, signal.SIGINT):
        asyncio.get_running_loop().add_signal_handler(signum, stopping.set)
    logger.info("forwarding %s:%s to %s:%s", *listen, *target)
    await stopping.wait()
    # Stop accepting; asyncio.run cancels any open connections on return.
    server.close()


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    asyncio.run(main(address(sys.argv[1]), address(sys.argv[2])))
