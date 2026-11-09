"""Command-line interface for substack_api."""

import argparse
import json
import sys
from typing import Any

from substack_api import (
    Category,
    Newsletter,
    Post,
    SubstackAuth,
    User,
    __version__,
    list_all_categories,
    resolve_handle_redirect,
)

QUICKSTART_TEXT = """\
substack — CLI for reading Substack newsletters, posts, and user profiles.

All output is JSON by default. Add --pretty for human-readable formatting.
Use --cookies <path> to authenticate for paywalled content.

COMMANDS
========

Newsletter:
  substack newsletter posts <url> [--sort new|top|pinned|community] [--limit N]
  substack newsletter search <url> <query> [--limit N]
  substack newsletter podcasts <url> [--limit N]
  substack newsletter recs <url>
  substack newsletter authors <url>

Post:
  substack post metadata <url>
  substack post content <url>
  substack post paywalled <url>

User:
  substack user info <username>
  substack user subscriptions <username>

Categories:
  substack categories
  substack category newsletters --name <name> [--metadata]
  substack category newsletters --id <id> [--metadata]

Other:
  substack resolve-handle <handle>
  substack version

EXAMPLES
========

  # List the 5 newest posts from a newsletter
  substack newsletter posts https://example.substack.com --limit 5

  # Search for posts about a topic
  substack newsletter search https://example.substack.com "machine learning"

  # Get full metadata for a specific post
  substack post metadata https://example.substack.com/p/my-post --pretty

  # Check if a post is paywalled
  substack post paywalled https://example.substack.com/p/my-post

  # Get the HTML content of a post (with auth for paywalled content)
  substack --cookies cookies.json post content https://example.substack.com/p/paid-post

  # Look up a user's subscriptions
  substack user subscriptions username

  # Browse newsletter categories
  substack categories
  substack category newsletters --name Technology

  # Resolve a renamed user handle
  substack resolve-handle oldusername

NOTES
=====
- API calls include a 2-second delay to be respectful to Substack's servers.
- Use --limit to avoid long waits when fetching posts from large newsletters.
- The cookies file should be a JSON file containing Substack session cookies.
"""


def _json_out(data: Any, pretty: bool = False) -> None:
    """Print data as JSON to stdout."""
    indent = 2 if pretty else None
    json.dump(data, sys.stdout, indent=indent, default=str)
    sys.stdout.write("\n")


def _get_auth(cookies_path: str | None):
    """Build auth object if cookies path provided."""
    if cookies_path:
        return SubstackAuth(cookies_path)
    return None


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="substack",
        description="CLI for the substack_api library",
    )
    parser.add_argument(
        "--cookies", metavar="PATH", help="Path to cookies JSON file for auth"
    )
    parser.add_argument(
        "--pretty", action="store_true", help="Pretty-print JSON output"
    )

    subparsers = parser.add_subparsers(dest="command")

    # quickstart
    subparsers.add_parser("quickstart", help="Print developer quickstart guide")

    # version
    subparsers.add_parser("version", help="Print version")

    # --- newsletter ---
    nl_parser = subparsers.add_parser("newsletter", help="Newsletter operations")
    nl_sub = nl_parser.add_subparsers(dest="subcommand")

    nl_posts = nl_sub.add_parser("posts", help="Get posts from a newsletter")
    nl_posts.add_argument("url", help="Newsletter URL")
    nl_posts.add_argument(
        "--sort",
        default="new",
        choices=["new", "top", "pinned", "community"],
        help="Sort order (default: new)",
    )
    nl_posts.add_argument("--limit", type=int, help="Max number of posts")

    nl_search = nl_sub.add_parser("search", help="Search posts in a newsletter")
    nl_search.add_argument("url", help="Newsletter URL")
    nl_search.add_argument("query", help="Search query")
    nl_search.add_argument("--limit", type=int, help="Max number of results")

    nl_podcasts = nl_sub.add_parser("podcasts", help="Get podcasts from a newsletter")
    nl_podcasts.add_argument("url", help="Newsletter URL")
    nl_podcasts.add_argument("--limit", type=int, help="Max number of podcasts")

    nl_recs = nl_sub.add_parser("recs", help="Get newsletter recommendations")
    nl_recs.add_argument("url", help="Newsletter URL")

    nl_authors = nl_sub.add_parser("authors", help="Get newsletter authors")
    nl_authors.add_argument("url", help="Newsletter URL")

    # --- post ---
    post_parser = subparsers.add_parser("post", help="Post operations")
    post_sub = post_parser.add_subparsers(dest="subcommand")

    post_meta = post_sub.add_parser("metadata", help="Get post metadata")
    post_meta.add_argument("url", help="Post URL")

    post_content = post_sub.add_parser("content", help="Get post HTML content")
    post_content.add_argument("url", help="Post URL")

    post_pay = post_sub.add_parser("paywalled", help="Check if post is paywalled")
    post_pay.add_argument("url", help="Post URL")

    # --- user ---
    user_parser = subparsers.add_parser("user", help="User operations")
    user_sub = user_parser.add_subparsers(dest="subcommand")

    user_info = user_sub.add_parser("info", help="Get user profile info")
    user_info.add_argument("username", help="Substack username")

    user_subs = user_sub.add_parser("subscriptions", help="Get user subscriptions")
    user_subs.add_argument("username", help="Substack username")

    # --- categories ---
    subparsers.add_parser("categories", help="List all categories")

    # --- category ---
    cat_parser = subparsers.add_parser("category", help="Category operations")
    cat_sub = cat_parser.add_subparsers(dest="subcommand")

    cat_nl = cat_sub.add_parser("newsletters", help="Get newsletters in a category")
    cat_nl_group = cat_nl.add_mutually_exclusive_group(required=True)
    cat_nl_group.add_argument("--name", help="Category name")
    cat_nl_group.add_argument("--id", type=int, help="Category ID")
    cat_nl.add_argument(
        "--metadata", action="store_true", help="Include full metadata"
    )

    # --- resolve-handle ---
    rh = subparsers.add_parser("resolve-handle", help="Resolve a renamed handle")
    rh.add_argument("handle", help="The handle to resolve")

    return parser


def _dispatch(args: argparse.Namespace) -> None:
    """Dispatch to the appropriate handler based on parsed args."""
    pretty = args.pretty

    if args.command == "quickstart":
        print(QUICKSTART_TEXT)
        return

    if args.command == "version":
        print(__version__)
        return

    if args.command == "newsletter":
        if not args.subcommand:
            print("Usage: substack newsletter {posts,search,podcasts,recs,authors}", file=sys.stderr)
            sys.exit(1)

        auth = _get_auth(args.cookies)
        nl = Newsletter(args.url, auth=auth)

        if args.subcommand == "posts":
            posts = nl.get_posts(sorting=args.sort, limit=args.limit)
            _json_out([{"url": p.url} for p in posts], pretty)
        elif args.subcommand == "search":
            posts = nl.search_posts(query=args.query, limit=args.limit)
            _json_out([{"url": p.url} for p in posts], pretty)
        elif args.subcommand == "podcasts":
            posts = nl.get_podcasts(limit=args.limit)
            _json_out([{"url": p.url} for p in posts], pretty)
        elif args.subcommand == "recs":
            recs = nl.get_recommendations()
            _json_out([{"url": r.url} for r in recs], pretty)
        elif args.subcommand == "authors":
            authors = nl.get_authors()
            _json_out([{"username": a.username} for a in authors], pretty)
        return

    if args.command == "post":
        if not args.subcommand:
            print("Usage: substack post {metadata,content,paywalled}", file=sys.stderr)
            sys.exit(1)

        auth = _get_auth(args.cookies)
        post = Post(args.url, auth=auth)

        if args.subcommand == "metadata":
            _json_out(post.get_metadata(), pretty)
        elif args.subcommand == "content":
            _json_out({"url": post.url, "html": post.get_content()}, pretty)
        elif args.subcommand == "paywalled":
            _json_out({"url": post.url, "paywalled": post.is_paywalled()}, pretty)
        return

    if args.command == "user":
        if not args.subcommand:
            print("Usage: substack user {info,subscriptions}", file=sys.stderr)
            sys.exit(1)

        user = User(args.username)

        if args.subcommand == "info":
            _json_out(user.get_raw_data(), pretty)
        elif args.subcommand == "subscriptions":
            _json_out(user.get_subscriptions(), pretty)
        return

    if args.command == "categories":
        cats = list_all_categories()
        _json_out([{"name": name, "id": id} for name, id in cats], pretty)
        return

    if args.command == "category":
        if not args.subcommand:
            print("Usage: substack category {newsletters}", file=sys.stderr)
            sys.exit(1)

        cat = Category(name=args.name, id=args.id)

        if args.subcommand == "newsletters":
            if args.metadata:
                _json_out(cat.get_newsletter_metadata(), pretty)
            else:
                _json_out(cat.get_newsletter_urls(), pretty)
        return

    if args.command == "resolve-handle":
        result = resolve_handle_redirect(args.handle)
        _json_out({"old_handle": args.handle, "new_handle": result}, pretty)
        return


def main() -> None:
    """CLI entry point."""
    parser = _build_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    try:
        _dispatch(args)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
