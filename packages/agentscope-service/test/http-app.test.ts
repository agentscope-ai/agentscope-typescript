import type { AgentScopeServiceApp } from '../src/app';
import { createHTTPRouter } from '../src/http';

const PYTHON_ROUTE_CONTRACT = `
DELETE /agent/{agent_id}
DELETE /channels/{channel_id}
DELETE /credential/{credential_id}
DELETE /knowledge_bases/{knowledge_base_id}
DELETE /knowledge_bases/{knowledge_base_id}/documents/{document_id}
DELETE /mcp/{mcp_id}
DELETE /schedule/{schedule_id}
DELETE /sessions/{session_id}
DELETE /skill/{skill_id}
DELETE /workspace/mcp/{mcp_name}
DELETE /workspace/skill/{skill_name}
GET /agent/
GET /agent/schema
GET /agent/schema/v2
GET /channels/
GET /channels/types
GET /channels/{channel_id}
GET /channels/{channel_id}/chat_ids
GET /channels/{channel_id}/sessions
GET /channels/{channel_id}/status
GET /credential/
GET /credential/schemas
GET /embedding-model/
GET /health
GET /hub/mcp
GET /hub/mcp/{hub_id}/cards
GET /hub/mcp/{hub_id}/cards/{card_id}
GET /hub/skill
GET /hub/skill/{hub_id}/cards
GET /hub/skill/{hub_id}/cards/{card_id:path}
GET /knowledge_bases/
GET /knowledge_bases/chunkers
GET /knowledge_bases/embedding_models
GET /knowledge_bases/middleware/parameters_schema
GET /knowledge_bases/supported_content_types
GET /knowledge_bases/{knowledge_base_id}/documents
GET /knowledge_bases/{knowledge_base_id}/documents/status
GET /knowledge_bases/{knowledge_base_id}/documents/{document_id}
GET /knowledge_bases/{knowledge_base_id}/documents/{document_id}/chunks
GET /mcp
GET /model/
GET /schedule/
GET /schedule/{schedule_id}/sessions
GET /sessions/
GET /sessions/{session_id}/messages
GET /sessions/{session_id}/status
GET /sessions/{session_id}/stream
GET /skill
GET /skill/{skill_id}
GET /tts-model/
GET /workspace/directories
GET /workspace/files
GET /workspace/mcp
GET /workspace/skill
GET /workspace/status
PATCH /agent/{agent_id}
PATCH /channels/{channel_id}
PATCH /credential/{credential_id}
PATCH /knowledge_bases/{knowledge_base_id}
PATCH /mcp/{mcp_id}
PATCH /schedule/{schedule_id}
PATCH /sessions/{session_id}
POST /agent/
POST /channels/
POST /channels/{channel_id}/disable
POST /channels/{channel_id}/enable
POST /chat/
POST /credential/
POST /hub/mcp/{hub_id}/cards/{card_id}/install
POST /hub/skill/{hub_id}/cards/{card_id:path}/install
POST /knowledge_bases/
POST /knowledge_bases/{knowledge_base_id}/documents
POST /knowledge_bases/{knowledge_base_id}/documents/{document_id}/download_token
POST /knowledge_bases/{knowledge_base_id}/search
POST /schedule/
POST /sessions/
POST /sessions/{session_id}/interrupt
POST /workspace/files/download-token
POST /workspace/mcp
POST /workspace/mcp/from-library
POST /workspace/skill
POST /workspace/skill/from-library
POST /workspace/skill/upload
`
    .trim()
    .split('\n')
    .sort();

describe('complete HTTP application', () => {
    test('registers the exact Python router method/path contract', () => {
        const router = createHTTPRouter({} as AgentScopeServiceApp);
        const actual = router
            .listRoutes()
            .map(route => `${route.method} ${route.path}`)
            .sort();
        expect(actual).toEqual(PYTHON_ROUTE_CONTRACT);
        expect(new Set(actual).size).toBe(83);
    });

    test('accepts optional AG-UI and custom response middleware', () => {
        const router = createHTTPRouter({} as AgentScopeServiceApp, {
            aguiProtocol: true,
            middleware: [async (_request, next) => next()],
        });
        expect(router.listRoutes()).toHaveLength(83);
    });
});
