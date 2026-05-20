# DS008: Room Types (Team vs Public Meeting)

## Overview

WebMeet supports two types of rooms to accommodate different collaboration scenarios:

- **Team Room**: Accessible only to authenticated workspace members
- **Public meeting**: Accessible via a shareable link, allowing external participants to join without workspace authentication. Internally this remains `roomType: 'guest'`.

## Room Types

### Team Room

**Purpose**: Internal collaboration within the workspace team.

**Access Control**:
- Only authenticated users with workspace access can join
- Requires valid session/authentication via assistOS
- Participants are identified by their workspace identity

**Use Cases**:
- Daily standups
- Internal team meetings
- Project reviews
- Workspace-only discussions

### Public Meeting

**Purpose**: External collaboration with participants outside the workspace.

**Access Control**:
- Accessible via unique shareable URL containing a guest token
- No workspace authentication required
- `webmeetAgent/manifest.json` declares the invite path as a guest-only HTTP service, so the Ploinky router sends a signed `__http_service__` invocation to the WebMeet proxy
- Guests must provide their name before joining
- Guests receive a unique participant identity

**Use Cases**:
- Client meetings
- Interviews
- External consultations
- Demos for prospects

## Data Model

### Meeting Record Extensions

```typescript
interface MeetingRecord {
    // ... existing fields ...
    roomType: 'team' | 'guest';
    guestToken?: string; // Only present for public meetings
}
```

### API Changes

#### Create Meeting

```typescript
POST /api/workspaces/:workspaceId/meetings
{
    title: string;
    roomType: 'team' | 'guest'; // Optional, defaults to 'team'
}

// Response includes:
{
    id: string;
    roomType: 'team' | 'guest';
    guestToken?: string; // Only for public meetings
    // ... other fields ...
}
```

#### Join Meeting (Authenticated)

```typescript
POST /api/meetings/:meetingId/join
{
    displayName?: string;
    participantId?: string;
}
// Requires authentication
```

#### Join Guest Meeting (Unauthenticated)

```typescript
POST /api/meetings/:meetingId/join-guest
{
    guestToken: string;
    displayName: string; // Required for guests
    participantId?: string;
}
// No authentication required
// Must arrive through /public-services/webmeet/... with a router-issued guest invocation
```

## Public Meeting Flow

### 1. Room Creation (Admin)

1. Admin clicks "New" button in WebMeet dashboard
2. Webskel modal `create-room-modal` opens with:
   - Room type selection (Team Room / Public meeting)
   - Room title input
3. Admin selects "Public meeting" and provides title
4. System creates room and generates unique `guestToken`
5. Guest URL is displayed: `https://{host}/public-services/webmeet/guest?room={roomId}&token={guestToken}`
6. Admin can copy and share the link

### 2. Guest Access

1. Guest receives URL via any channel (email, chat, etc.)
2. Guest opens URL in browser
3. System detects guest access and shows name input form
4. Guest enters their name
5. System calls `join-guest` API with token and name
6. Guest joins the room with generated participant identity

### 3. Security Considerations

- Guest tokens are UUID v4 random strings
- Tokens are stored encrypted in the meeting record
- Guest HTTP routes reject unsigned `x-ploinky-auth-info` headers and require a verified Ploinky invocation token with the guest role
- Guest access is limited to the WebMeet public-service route; it must not expose Explorer or generic MCP agent routes
- WebMeet must not set manifest-level `guest: true`; unlike visitor-only agents such as webAssist, WebMeet guests are scoped to the invite HTTP service so they cannot reach the agent's general MCP tools
- Public meetings can be converted to team rooms (future feature)
- Guest access can be revoked by regenerating token (future feature)

## UI Components

### Create Room Modal

**Location**: `webmeetAgent/IDE-plugins/webmeet-tool-button/components/create-room-modal/`

**Structure**:
- Modal header with title "Create New Room"
- Room type selection cards (Team Room / Public meeting)
- Room title input
- Cancel and Create buttons

**Behavior**:
- Team Room is pre-selected by default
- Public meeting shows "link access" description
- Title defaults to "Standup"

### Room List Indicators

**Team Room Icon**: Video camera icon (existing)
**Public meeting icon**: Link icon with different color
**Public meeting badge**: Link indicator next to title

## Implementation Details

### Backend (webmeetStore.mjs)

```javascript
function createMeetingRecord(context, effectiveWorkspaceId, title, roomType = 'team') {
    const isGuestRoom = roomType === 'guest';
    const guestToken = isGuestRoom ? crypto.randomUUID() : null;
    
    const record = {
        // ... existing fields ...
        roomType: isGuestRoom ? 'guest' : 'team',
        guestToken,
        // ...
    };
}

export function joinGuestMeeting(context, { meetingId, guestToken, displayName, participantId }) {
    // Verify room type is 'guest'
    // Validate guest token matches
    // Create participant without requiring auth
}
```

### API Layer (webmeet-api.mjs)

- Added `joinGuestMeeting` to imports
- New route: `['meetings.join.guest', 'POST', /^\/api\/meetings\/([^/]+)\/join-guest$/]`
- Handler validates token and allows unauthenticated access

### Frontend (WebMeet Dashboard)

- `createMeeting()` now calls `assistOS.UI.showModal('create-room-modal')`
- Public meeting creation shows confirmation with invite URL
- URL is auto-copied to clipboard when possible
- Room list shows type indicators

## Security Boundaries

| Aspect | Team Room | Public meeting |
|--------|-----------|------------|
| Authentication | Required | Not required |
| Access Control | Workspace membership | Guest token possession |
| Participant Identity | Workspace identity | Self-declared name |
| Data Visibility | Workspace policy | Same as team room |
| Recording Access | Workspace members | Same as team room |

## Media Transport Behavior

WebMeet publishes screen-share video without LiveKit simulcast so remote receivers subscribe to a single screen-share RTP stream across local and production topologies. The client may emit WebRTC media diagnostics only when an explicit debug flag such as `WEBMEET_MEDIA_DEBUG` or `webmeetMediaDebug=1` is enabled; those diagnostics must summarize track, publication, and video-element state without logging tokens, SDP, ICE candidates, or credentials.

## Future Enhancements

- Token expiration/revocation
- Public meeting password protection
- Maximum guest count limits
- Guest waiting room (approval required)
- Conversion between room types
- Guest access audit log
