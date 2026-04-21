import logging
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from backend.api.test import router as test_router
from backend.config import settings
from backend.api import (
    patients,
    context_briefs,
    appointments,
    soap_notes,
    form_drafts,
    orchestrate,
    audit,
    health,
)

logging.basicConfig(level=settings.log_level)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Warriors AI Copilot API",
    description="Three-phase AI copilot for Ontario family physicians",
    version="0.1.0",
)

app.include_router(test_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url, "http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# All user-facing routes under /api
app.include_router(patients.router, prefix="/api")
app.include_router(context_briefs.router, prefix="/api")
app.include_router(appointments.router, prefix="/api")
app.include_router(soap_notes.router, prefix="/api")
app.include_router(form_drafts.router, prefix="/api")
app.include_router(orchestrate.router, prefix="/api")
app.include_router(audit.router, prefix="/api")

# Health check has no /api prefix
app.include_router(health.router)


@app.get("/")
async def root():
    return {"message": "Warriors AI Copilot API", "version": "0.1.0", "docs": "/docs"}


@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    logger.error(f"Unhandled exception: {exc}", exc_info=True)
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})