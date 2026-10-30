"""Seed the Daily sandbox with one fictional reader and a ready, three-article feed.

Run inside the daily-api container with Daily's installed psycopg driver:

    docker compose ... exec -T daily-api python /lab/seed.py < request.json

stdin is {"tokenHash": "<sha256 hex>"}. The controller keeps the plaintext
session token outside the container; Daily stores only this hash, exactly as
its sign-in handlers do. Fixture IDs come from fixture.json, and every row is
upserted in one transaction, so repeated runs refresh rows instead of adding
duplicates. Feed-cache timestamps are reset to now() because Daily ignores
cache rows older than 60 minutes. Prints a JSON report on stdout.
"""
import json
import os
import re
import sys
import uuid
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

FIXTURE = json.loads(Path(__file__).with_name("fixture.json").read_text())
TABLES = ("users", "sessions", "user_preferences", "user_sources", "articles", "user_feed_cache")


def read_token_hash():
    try:
        request = json.load(sys.stdin)
    except json.JSONDecodeError:
        request = None
    token_hash = request.get("tokenHash") if isinstance(request, dict) else None
    if not isinstance(token_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", token_hash):
        raise SystemExit('seed.py reads {"tokenHash": "<64 lowercase hex characters>"} on stdin.')
    return token_hash


def main():
    token_hash = read_token_hash()
    reader, source, articles = FIXTURE["reader"], FIXTURE["source"], FIXTURE["articles"]
    keys = {
        "user_id": uuid.UUID(reader["userId"]),
        "session_id": uuid.UUID(reader["sessionId"]),
        "source_url": source["url"],
        "article_ids": [uuid.UUID(article["id"]) for article in articles],
    }
    with psycopg.connect(
        os.environ["DATABASE_URL"], autocommit=True, row_factory=dict_row, connect_timeout=5
    ) as conn:
        with conn.transaction(), conn.cursor() as cur:
            cur.execute("SET LOCAL statement_timeout = '10s'")
            cur.execute("SET LOCAL lock_timeout = '5s'")
            cur.execute(
                """
                SELECT
                  (SELECT count(*) FROM public.users WHERE id = %(user_id)s) AS users,
                  (SELECT count(*) FROM public.sessions WHERE id = %(session_id)s) AS sessions,
                  (SELECT count(*) FROM public.user_preferences
                    WHERE user_id = %(user_id)s) AS user_preferences,
                  (SELECT count(*) FROM public.user_sources
                    WHERE user_id = %(user_id)s AND source_url = %(source_url)s) AS user_sources,
                  (SELECT count(*) FROM public.articles
                    WHERE id = ANY(%(article_ids)s)) AS articles,
                  (SELECT count(*) FROM public.user_feed_cache
                    WHERE user_id = %(user_id)s AND article_id = ANY(%(article_ids)s)) AS user_feed_cache
                """,
                keys,
            )
            existing = cur.fetchone()

            cur.execute(
                """
                INSERT INTO public.users (id, email, display_name, last_login)
                VALUES (%s, %s, %s, now())
                ON CONFLICT (id) DO UPDATE SET
                  email = EXCLUDED.email, display_name = EXCLUDED.display_name,
                  is_deleted = false, deleted_at = NULL, last_login = now(), updated_at = now()
                """,
                (keys["user_id"], reader["email"], reader["displayName"]),
            )
            # Daily's sign-in format: SHA-256 hex of the token, 30-day expiry.
            cur.execute(
                """
                INSERT INTO public.sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at)
                VALUES (%s, %s, %s, now(), now(), now() + interval '30 days')
                ON CONFLICT (id) DO UPDATE SET
                  user_id = EXCLUDED.user_id, token_hash = EXCLUDED.token_hash,
                  last_seen_at = now(), expires_at = EXCLUDED.expires_at
                """,
                (keys["session_id"], keys["user_id"], token_hash),
            )
            # Same transaction, same now(): preferences are never newer than the
            # cache rows below, which Daily would otherwise treat as stale.
            cur.execute(
                """
                INSERT INTO public.user_preferences
                  (id, user_id, interests, ai_profile, completed, completed_at, updated_at)
                VALUES (%s, %s, %s, %s, true, now(), now())
                ON CONFLICT (user_id) DO UPDATE SET
                  interests = EXCLUDED.interests, ai_profile = EXCLUDED.ai_profile, completed = true,
                  completed_at = COALESCE(public.user_preferences.completed_at, now()),
                  updated_at = now()
                """,
                (
                    uuid.UUID(reader["preferencesId"]),
                    keys["user_id"],
                    json.dumps(reader["interests"]),
                    reader["aiProfile"],
                ),
            )
            cur.execute(
                """
                INSERT INTO public.user_sources
                  (id, user_id, source_url, source_name, category, discovery_method, active)
                VALUES (%s, %s, %s, %s, %s, 'agent_lab_fixture', true)
                ON CONFLICT (user_id, source_url) DO UPDATE SET
                  source_name = EXCLUDED.source_name, category = EXCLUDED.category,
                  discovery_method = EXCLUDED.discovery_method, active = true, failure_count = 0
                """,
                (uuid.UUID(source["id"]), keys["user_id"], source["url"], source["name"], source["category"]),
            )
            cur.executemany(
                """
                INSERT INTO public.articles (id, url, title, summary, author, source_name,
                  published_at, ingested_at, category, canonical_source_domain)
                VALUES (%(id)s, %(url)s, %(title)s, %(summary)s, 'Agent Lab fixture', %(source_name)s,
                  now() - make_interval(mins => %(minutes)s), now(), %(category)s, 'example.com')
                ON CONFLICT (id) DO UPDATE SET
                  url = EXCLUDED.url, title = EXCLUDED.title, summary = EXCLUDED.summary,
                  author = EXCLUDED.author, source_name = EXCLUDED.source_name,
                  published_at = EXCLUDED.published_at, ingested_at = EXCLUDED.ingested_at,
                  category = EXCLUDED.category,
                  canonical_source_domain = EXCLUDED.canonical_source_domain
                """,
                [
                    {
                        "id": uuid.UUID(article["id"]),
                        "url": article["url"],
                        "title": article["title"],
                        "summary": article["summary"],
                        "source_name": source["name"],
                        "minutes": article["publishedMinutesAgo"],
                        "category": article["category"],
                    }
                    for article in articles
                ],
            )
            cur.execute(
                """
                DELETE FROM public.user_feed_cache
                WHERE user_id = %(user_id)s AND NOT (article_id = ANY(%(article_ids)s))
                """,
                keys,
            )
            removed_cache_rows = cur.rowcount
            cur.executemany(
                """
                INSERT INTO public.user_feed_cache
                  (user_id, article_id, relevance_score, relevant, relevance_reason, created_at)
                VALUES (%s, %s, %s, true, 'Agent Lab fixture: matches the test reader', now())
                ON CONFLICT (user_id, article_id) DO UPDATE SET
                  relevance_score = EXCLUDED.relevance_score, relevant = true,
                  relevance_reason = EXCLUDED.relevance_reason, created_at = now()
                """,
                [
                    (keys["user_id"], uuid.UUID(article["id"]), article["relevanceScore"])
                    for article in articles
                ],
            )

        totals = conn.execute(
            "SELECT " + ", ".join(f"(SELECT count(*) FROM public.{table}) AS {table}" for table in TABLES)
        ).fetchone()

    fixture_rows = {table: 1 for table in TABLES} | {
        "articles": len(articles),
        "user_feed_cache": len(articles),
    }
    print(
        json.dumps(
            {
                "tables": {
                    table: {
                        "fixture": fixture_rows[table],
                        "existing": existing[table],
                        "total": totals[table],
                    }
                    for table in TABLES
                },
                "removedCacheRows": removed_cache_rows,
            }
        )
    )


if __name__ == "__main__":
    main()
