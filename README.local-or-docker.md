# Local and Docker Build Guide

This project is scaffolded with a FastAPI backend and a Next.js frontend. Use this guide to run locally or via Docker Compose.

Local development (recommended for quick iteration)
- Prerequisites: Python 3.11+, Node.js 18+ installed
- Backend:
  - Navigate to backend and create a virtualenv: `python -m venv .venv && source .venv/bin/activate`
  - Install: `pip install -r requirements.txt`
  - Run: `uvicorn app.main:app --reload --port 8000 --host 0.0.0.0`
- Frontend:
  - Navigate to frontend and install: `npm install`
  - Run: `npm run dev`
- API base URL for frontend: http://localhost:8000

Docker Compose
- Start: `docker-compose up -d`
- Endpoints:
  - API health: http://localhost:8000/healthz
- Frontend: http://localhost:3000
