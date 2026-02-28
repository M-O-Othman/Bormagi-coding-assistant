# Skill: API Design Conventions

Apply these conventions when designing, reviewing, or documenting any HTTP API — REST or REST-adjacent. Consistent APIs reduce integration friction and support documentation tooling.

## URL Structure

- Use **kebab-case** for path segments: `/user-profiles`, not `/userProfiles` or `/user_profiles`.
- Use **plural nouns** for resource collections: `/documents`, `/users`, `/notifications`.
- Nest only one level deep for sub-resources: `/users/{id}/documents` — not `/users/{id}/documents/{docId}/revisions/{revId}`.
- Never use verbs in paths. The HTTP method is the verb: `DELETE /users/{id}`, not `POST /users/{id}/delete`.
- Version the API in the path: `/api/v1/...`. Never version in headers (hard to test, hard to route).

| Good | Avoid |
|---|---|
| `GET /api/v1/documents` | `GET /api/getDocuments` |
| `POST /api/v1/documents` | `POST /api/v1/createDocument` |
| `GET /api/v1/documents/{id}` | `GET /api/v1/document?id=123` |
| `PATCH /api/v1/users/{id}` | `PUT /api/v1/users/update/{id}` |

## HTTP Methods

| Method | Use for | Body? | Idempotent? |
|---|---|---|---|
| `GET` | Read a resource or collection | No | Yes |
| `POST` | Create a resource | Yes | No |
| `PUT` | Replace a resource entirely | Yes | Yes |
| `PATCH` | Partial update (only provided fields) | Yes | No |
| `DELETE` | Remove a resource | No | Yes |

Use `PATCH` for updates — not `PUT` — unless you require a full-replacement semantics.

## Request and Response Bodies

- Always use `Content-Type: application/json`.
- Use **camelCase** for JSON property names in REST APIs: `{ "userId": "...", "createdAt": "..." }`.
- Timestamps: always **ISO 8601** with timezone: `"2026-02-28T14:30:00Z"`.
- Booleans: never use `0`/`1` or `"true"`/`"false"` strings — use native JSON booleans.
- Nullable fields: include them with `null` rather than omitting — absence vs null has different semantics.
- Enumerations: use uppercase strings: `"status": "ACTIVE"`, not `0`, `1`, or `"active"`.

## Pagination

Use **cursor-based pagination** for all collection endpoints. Offset pagination breaks under concurrent writes.

```json
GET /api/v1/documents?cursor=eyJpZCI6MTIzfQ&limit=20

Response:
{
  "data": [...],
  "pagination": {
    "nextCursor": "eyJpZCI6MTQzfQ",
    "hasMore": true,
    "limit": 20
  }
}
```

- Default `limit`: 20. Maximum `limit`: 100. Reject requests above the maximum with `400`.
- When there are no more results: `"hasMore": false`, `"nextCursor": null`.

## Error Response Format

Every error response uses the same structure — never return plain strings or HTML:

```json
{
  "error": {
    "code": "DOCUMENT_NOT_FOUND",
    "message": "No document exists with id 'abc-123'.",
    "details": {
      "resourceId": "abc-123",
      "resourceType": "document"
    }
  }
}
```

- `code`: machine-readable SCREAMING_SNAKE_CASE string. Stable across API versions.
- `message`: human-readable English sentence. May change between versions.
- `details`: optional structured object with context for programmatic handling.

## HTTP Status Codes

Use the correct status code — never return `200` with an error body:

| Code | Use |
|---|---|
| `200 OK` | Successful GET, PATCH, PUT |
| `201 Created` | Successful POST that created a resource |
| `204 No Content` | Successful DELETE or action with no response body |
| `400 Bad Request` | Malformed request, invalid field values, failed validation |
| `401 Unauthorised` | No valid authentication credentials |
| `403 Forbidden` | Authenticated but not authorised for this action |
| `404 Not Found` | Resource does not exist |
| `409 Conflict` | Resource state conflict (e.g., duplicate unique field) |
| `422 Unprocessable Entity` | Semantically invalid request (valid JSON, failed business rule) |
| `429 Too Many Requests` | Rate limit exceeded |
| `500 Internal Server Error` | Unexpected server-side failure |

## Authentication

All endpoints (except `/auth/login` and `/auth/register`) require a Bearer token:

```
Authorization: Bearer <access_token>
```

- Never put tokens in query parameters — they appear in server logs.
- Return `401` if the token is missing or invalid; `403` if the token is valid but the user lacks permission.
- Include `WWW-Authenticate: Bearer realm="api", error="invalid_token"` on `401` responses.

## OpenAPI Specification

Every API must have an OpenAPI 3.1 spec. The spec is the source of truth — generate client SDKs and docs from it. Key rules:

- All schemas defined in `components/schemas`, referenced with `$ref`.
- All responses documented, including `4xx` and `5xx`.
- At least one `example` per request body and response.
- `operationId` on every endpoint (used for SDK method naming): camelCase verb + noun: `listDocuments`, `createUser`.
