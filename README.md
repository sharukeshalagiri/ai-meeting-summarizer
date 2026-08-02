# AI Meeting Summarizer

> An AI-powered meeting intelligence platform designed to transform raw conversations into searchable, actionable, and continuously evolving knowledge.

AI Meeting Summarizer is a full-stack meeting intelligence platform that goes beyond simply transcribing and summarizing meetings.

The current system can process recorded meetings, generate transcripts and structured summaries, extract action items, provide intelligent search, support semantic retrieval, analyze meeting data, and lay the foundation for real-time meeting intelligence.

The long-term goal is to evolve this into a complete **AI meeting companion** that understands meetings while they happen, maintains contextual memory across meetings, identifies decisions and commitments, and allows users to interact with their organization's meeting knowledge conversationally.

---

##  What Is This Project?

Most meeting AI products follow a relatively simple pipeline:

```text
Meeting
   ↓
Transcription
   ↓
Summary
   ↓
Done
```

This project is designed around a larger idea:

```text
Meeting
   ↓
Audio Processing
   ↓
Transcription
   ↓
Speaker / Segment Intelligence
   ↓
Structured Understanding
   ↓
Embeddings + Semantic Retrieval
   ↓
Knowledge Layer
   ↓
Search / Q&A / Analytics / Action Items
   ↓
Long-Term Meeting Intelligence
```

Instead of treating a meeting as a single audio file and a single summary, the system treats the meeting as a collection of structured information that can be queried, analyzed, and reused later.

---

##  Current Features

-  Meeting audio upload
-  Automatic speech-to-text transcription
-  AI-generated meeting summaries
-  Structured action-item extraction
-  Speaker and segment-oriented meeting processing
-  Semantic meeting search
-  Embedding-based retrieval
-  Ask questions about meeting knowledge
-  Meeting analytics
-  Live meeting capture infrastructure
-  Browser extension foundation
-  Persistent PostgreSQL storage
-  Database migrations with Prisma
-  Modular backend architecture

The project is actively being developed, so some capabilities are currently implemented as foundations or early versions rather than production-complete features.

---

#  Architecture

The application is organized as a multi-service system:

```text
                         ┌─────────────────────┐
                         │   React Frontend    │
                         │       + Vite        │
                         └──────────┬──────────┘
                                    │
                                    │ REST API
                                    ▼
                         ┌─────────────────────┐
                         │   Node.js Backend   │
                         │ Express + TypeScript│
                         └──────────┬──────────┘
                                    │
                   ┌────────────────┼────────────────┐
                   │                │                │
                   ▼                ▼                ▼
            ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
            │ PostgreSQL  │  │   Gemini    │  │ AI Service  │
            │   + Prisma  │  │     API     │  │   FastAPI   │
            └─────────────┘  └─────────────┘  └──────┬──────┘
                                                     │
                                                     ▼
                                                  Whisper
```

### Frontend

The React frontend provides the user-facing meeting workspace, including:

- Dashboard
- Meeting management
- Meeting details
- Transcript visualization
- Summary views
- Action-item views
- Analytics
- Semantic search and Q&A
- Live meeting interface

### Backend

The Node.js and Express backend acts as the central application layer.

Responsibilities include:

- REST API
- Meeting management
- File uploads
- Transcript management
- Summary generation orchestration
- Action-item management
- Search and retrieval
- Embedding management
- Analytics
- Live meeting sessions
- Database access

The backend follows a modular architecture:

```text
Routes
  ↓
Controllers
  ↓
Services
  ↓
Repositories
  ↓
Prisma
  ↓
PostgreSQL
```

This separates HTTP handling, business logic, and persistence concerns.

### AI Service

A separate Python service handles speech recognition:

```text
Audio
  ↓
FastAPI
  ↓
Whisper
  ↓
Transcript
```

Keeping speech processing separate from the main Node.js application allows computationally intensive AI workloads to evolve independently from the application backend.

---

#  AI Pipeline

A simplified version of the current intelligence pipeline:

```text
Meeting Audio
      ↓
Audio Upload
      ↓
Speech-to-Text
      ↓
Transcript Segmentation
      ↓
Structured Meeting Data
      ↓
 ┌────┴───────────────┐
 │                    │
 ▼                    ▼
Summary           Action Items
 │                    │
 └─────────┬──────────┘
           ▼
       Embeddings
           ↓
   Semantic Retrieval
           ↓
      Search / Q&A
```

The long-term architecture is designed to allow the transcript to become a persistent knowledge representation rather than simply an output displayed once after a meeting.

---

#  Data Layer

The application uses:

- **PostgreSQL** as the primary relational database
- **Prisma ORM** for database access and schema management
- **Vector embeddings** for semantic retrieval
- **Prisma Migrate** for controlled database evolution

Meeting information is stored as structured entities rather than a single generated document.

This allows the system to work with individual concepts such as:

- Meetings
- Transcripts
- Segments
- Summaries
- Action items
- Embeddings
- Live sessions
- Search and chat context

The goal is to make meeting information composable and queryable.

---

# 🛠️ Technology Stack

### Frontend

- React
- TypeScript
- Vite
- CSS

### Backend

- Node.js
- Express.js
- TypeScript
- REST APIs
- Multer
- Axios
- CORS
- dotenv

### Database

- PostgreSQL
- Prisma ORM
- Prisma Migrate
- Vector embeddings / semantic retrieval

### AI / ML

- Python
- FastAPI
- OpenAI Whisper
- Google Gemini
- Embedding models
- Retrieval-Augmented Generation concepts

### Browser Integration

- Browser Extension APIs
- JavaScript

### Development

- Git
- GitHub
- npm
- Python virtual environments

---

# 🎯 Long-Term Goal

The current project is only the foundation.

The ultimate goal is to build an **AI meeting operating system** rather than another transcription tool.

The envisioned system would be able to:

## 1. Understand Meetings in Real Time

Instead of waiting for a meeting to finish:

```text
Conversation
     ↓
Real-Time Transcription
     ↓
Live Understanding
     ↓
Decisions
Action Items
Questions
Risks
Important Topics
```

The AI should continuously understand what is happening during the meeting.

---

## 2. Build Persistent Organizational Memory

Meetings should not exist in isolation.

For example:

```text
Monday Meeting
     ↓
"Let's ship feature X next Friday."

     ↓

Thursday Meeting
     ↓
"What happened with feature X?"

     ↓

AI retrieves the relevant previous discussion
```

The system should understand relationships between meetings, topics, people, decisions, and action items.

---

## 3. Answer Questions Across Meetings

Instead of searching individual transcripts:

> "What did we decide about the database architecture last month?"

The system should retrieve relevant context across multiple meetings and produce an evidence-backed answer.

---

## 4. Track Commitments

The system should understand statements such as:

> "I'll finish the API integration by Friday."

and turn them into structured commitments:

```text
Owner: Person
Task: API Integration
Deadline: Friday
Source: Meeting X
Status: Pending
```

It should then track whether that commitment was discussed or completed in subsequent meetings.

---

## 5. Become Proactive

The ultimate version should not merely answer questions.

It should proactively surface information such as:

```text
⚠️ Potentially overdue action item

"Complete payment API integration"

Assigned to: Alex
Due: Friday
Last discussed: 6 days ago
Status: No completion detected
```

This moves the system from **meeting summarization** toward **meeting intelligence**.

---

# 🆚 How This Is Different

The goal is not to compete purely on transcription accuracy or summary generation.

The key difference is how meeting data is treated.

### Conventional Approach

```text
Meeting
   ↓
Transcript
   ↓
Summary
   ↓
User reads it
```

The summary becomes the final product.

### This Project's Intended Approach

```text
Meeting
   ↓
Transcript
   ↓
Structured Knowledge
   ↓
Persistent Memory
   ↓
Semantic Retrieval
   ↓
Cross-Meeting Context
   ↓
Action Tracking
   ↓
Analytics
   ↓
AI Interaction
```

The meeting becomes a **data source for an evolving knowledge system**.

### Key Differentiators

#### 🔹 Meeting Memory

Information should remain useful after the meeting ends instead of becoming another isolated summary.

#### 🔹 Semantic Understanding

Embeddings allow the system to retrieve conceptually related information even when the exact words used in a query do not appear in the transcript.

#### 🔹 Cross-Meeting Intelligence

The long-term system is designed to connect information across meetings rather than treating every meeting as an independent document.

#### 🔹 Action-Oriented Intelligence

The objective is not simply:

> "Here is what happened."

but:

> "Here is what happened, what was decided, what needs to happen next, who owns it, and what has changed since the previous discussion."

#### 🔹 Real-Time Intelligence

The project is designed to eventually understand meetings while they are happening rather than only processing recordings afterward.

#### 🔹 Extensible Architecture

The system separates the frontend, backend, and AI services so individual components can evolve independently.

---

# 📍 Current Project Status

**🚧 Active Development — Functional Prototype**

The project has progressed beyond a basic proof of concept.

### Currently Implemented

- [x] Meeting management
- [x] Audio upload
- [x] Whisper-based transcription
- [x] Structured summaries
- [x] Action-item infrastructure
- [x] PostgreSQL persistence
- [x] Prisma schema and migrations
- [x] Semantic embedding infrastructure
- [x] Search and retrieval infrastructure
- [x] Analytics infrastructure
- [x] Live meeting infrastructure
- [x] Browser extension foundation
- [x] React-based meeting interface

### Still Being Developed

The project is not yet intended to be considered a production-ready commercial product.

Major areas remaining for the long-term vision include:

- Robust real-time transcription
- Production-grade speaker diarization
- Reliable cross-meeting memory
- More advanced knowledge graphs
- Better citation and evidence handling for AI answers
- Authentication and authorization
- Multi-user organizations and workspaces
- Production deployment architecture
- Background job processing
- Scalable object storage for recordings
- Observability and monitoring
- Automated testing
- AI evaluation pipelines
- Calendar and conferencing integrations
- Security and privacy hardening

The current repository therefore represents a **working engineering foundation toward the larger product**, rather than the final product.

---

# 📂 Project Structure

```text
ai-meeting-summarizer/
│
├── ai-service/
│   ├── main.py
│   └── requirements.txt
│
├── backend/
│   ├── prisma/
│   │   ├── migrations/
│   │   └── schema.prisma
│   │
│   └── src/
│       ├── controllers/
│       ├── repositories/
│       ├── routes/
│       ├── services/
│       ├── types/
│       ├── middleware/
│       └── lib/
│
├── frontend/
│   └── src/
│       ├── components/
│       ├── hooks/
│       ├── pages/
│       ├── utils/
│       └── api/
│
├── extension/
│
├── docs/
│
├── package.json
├── package-lock.json
└── .gitignore
```

---

# 🔐 Environment Variables

Environment variables are intentionally excluded from the repository.

Create the required environment files using the provided examples.

Typical configuration includes:

```env
DATABASE_URL=
GEMINI_API_KEY=
GEMINI_MODEL=
EMBEDDING_MODEL=
EMBEDDING_DIMS=
AI_SERVICE_URL=
CORS_ORIGIN=
UPLOAD_DIR=
LIVE_CHUNK_DIR=
MAX_UPLOAD_MB=
MAX_CHUNK_MB=
```

**Never commit real API keys, database credentials, or private meeting recordings.**

---

#  Engineering Principles

This project is being built with a focus on understanding the underlying engineering rather than treating AI as a black box.

Key areas of focus include:

- Modular backend architecture
- Separation of concerns
- Relational database design
- REST API design
- AI service isolation
- Retrieval systems
- Vector search
- Data modeling
- Asynchronous processing
- Real-time systems
- Extensible architecture
- Production-oriented engineering

The objective is to gradually evolve the project from a functional prototype into a reliable, scalable AI product.

---

# 🗺️ Roadmap

### Phase 1 — Core Meeting Intelligence

- [x] Audio upload
- [x] Speech-to-text
- [x] Transcript persistence
- [x] AI summaries
- [x] Action-item foundation

### Phase 2 — Search & Knowledge

- [x] Embedding infrastructure
- [x] Semantic retrieval
- [x] Meeting search
- [x] AI Q&A foundation
- [ ] Cross-meeting memory
- [ ] Evidence-backed answers

### Phase 3 — Real-Time Intelligence

- [x] Live meeting infrastructure
- [ ] Robust real-time transcription
- [ ] Real-time topic detection
- [ ] Live action-item extraction
- [ ] Live decision detection

### Phase 4 — Organizational Memory

- [ ] Cross-meeting knowledge graph
- [ ] Persistent people/topic relationships
- [ ] Decision history
- [ ] Commitment tracking
- [ ] Automatic follow-ups

### Phase 5 — Production Platform

- [ ] Authentication
- [ ] Organizations / workspaces
- [ ] Calendar integrations
- [ ] Zoom / Google Meet integrations
- [ ] Cloud object storage
- [ ] Background workers
- [ ] Observability
- [ ] Automated testing
- [ ] Production deployment
- [ ] Security and privacy hardening

---

# 💡 Why Build This?

Meetings contain a huge amount of organizational knowledge, but much of that knowledge disappears into recordings, transcripts, chat messages, and people's memories.

The goal of this project is to make that information:

**Capturable → Structured → Searchable → Contextual → Actionable → Persistent**

The end goal is not simply to create shorter meeting notes.

It is to build a system that helps organizations **remember what happened, understand why decisions were made, track what needs to happen next, and retrieve that knowledge whenever it is needed.**

---

# 📌 Project Status

**🚧 Active Development**

This project serves both as a practical AI product and as an exploration of:

- Full-stack software engineering
- AI/ML integration
- Speech processing
- Retrieval-Augmented Generation
- Vector search
- Database architecture
- Real-time systems
- Service-oriented architecture
- Production software engineering

The repository represents the current working foundation of the project and will continue evolving toward the larger meeting-intelligence platform described above.

---

## License

This project is currently under active development. License details will be added as the project matures.
