# Lia v2 Architecture

Lia v2 — local-first personal AI companion with dual-memory architecture.

## Knowledge Base

Knowledge Base stores documents and project sources globally, separate from episode memory.

Hybrid search combines vector similarity, BM25 keyword matching, and RRF fusion.

## Agent Tools

The agent uses search_sources, get_source, and list_sources to query the knowledge base.
