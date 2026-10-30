"""Run Daily's real API for Agent Lab with its background jobs disabled.

Daily's lifespan() starts six polling loops: RSS ingestion, source quality,
interest evolution, per-user refresh, prewarming, and account maintenance. The
sandbox serves the feed only, so this launcher replaces those six entry points
with logged no-op coroutines before Uvicorn runs lifespan(). Schema
initialization, the connection pool, HTTP handlers, authentication, and feed
queries are Daily's unmodified code.
"""
import inspect
import logging

import uvicorn

# Importing Daily configures its logging and constructs its OpenAI client.
import app.main as daily

BACKGROUND_LOOPS = (
    "_ingestion_loop",
    "_source_quality_loop",
    "_interest_evolution_loop",
    "_per_user_refresh_loop",
    "_prewarm_loop",
    "_account_maintenance_loop",
)

logger = logging.getLogger("agent_lab.sandbox")


def disabled(name):
    async def loop():
        logger.info("Agent Lab sandbox: %s disabled; it returns without doing work", name)

    loop.__name__ = loop.__qualname__ = name
    return loop


def main():
    for name in BACKGROUND_LOOPS:
        # lifespan() looks these names up when it runs, so replacing the module
        # attributes is enough. A missing loop means unreviewed Daily code.
        if not inspect.iscoroutinefunction(getattr(daily, name, None)):
            raise SystemExit(f"Daily {daily.GIT_SHA} has no coroutine {name}; refusing to start.")
        setattr(daily, name, disabled(name))
    logger.warning(
        "Agent Lab sandbox: Daily build %s, feed-only, background jobs disabled (%s)",
        daily.GIT_SHA,
        ", ".join(BACKGROUND_LOOPS),
    )
    uvicorn.run(daily.app, host="0.0.0.0", port=8080, workers=1)


if __name__ == "__main__":
    main()
