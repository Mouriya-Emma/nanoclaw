---
name: mattermost-admin
description: Manage Mattermost — create/archive channels, invite users, post to any channel, pin messages, upload files, manage webhooks. Use when the user asks you to organize channels, bridge external data into Mattermost, or perform any platform management.
---

# Mattermost Admin

你可以通过 REST API 完全管理 Mattermost 平台。凭证在环境变量中：

```bash
# 验证可用
curl -s -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" "$MATTERMOST_URL/api/v4/users/me" | jq .username
```

所有 API 调用使用同一模式：

```bash
curl -s -X METHOD "$MATTERMOST_URL/api/v4/ENDPOINT" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d 'JSON_BODY'
```

下面按场景列出常用操作。

---

## Channel 管理

### 创建 channel

```bash
# 公开 channel (type: O), 私有 channel (type: P)
curl -s -X POST "$MATTERMOST_URL/api/v4/channels" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "team_id": "TEAM_ID",
    "name": "project-alpha",
    "display_name": "Project Alpha",
    "type": "O",
    "header": "Header text shown below channel name",
    "purpose": "Channel description"
  }' | jq '{id, name, display_name}'
```

`name` 必须小写字母+数字+连字符，不超过 64 字符。

### 列出 channels

```bash
# 该 team 所有公开 channels
curl -s "$MATTERMOST_URL/api/v4/teams/TEAM_ID/channels" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" | jq '.[] | {id, name, display_name, type}'

# 搜索 channel
curl -s -X POST "$MATTERMOST_URL/api/v4/teams/TEAM_ID/channels/search" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"term": "project"}' | jq '.[] | {id, name, display_name}'
```

### 修改 channel

```bash
# 更新 header、purpose、display_name
curl -s -X PUT "$MATTERMOST_URL/api/v4/channels/CHANNEL_ID/patch" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"header": "New header", "purpose": "Updated purpose"}'
```

### 归档 / 恢复 channel

```bash
# 归档（软删除）
curl -s -X DELETE "$MATTERMOST_URL/api/v4/channels/CHANNEL_ID" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN"

# 恢复
curl -s -X POST "$MATTERMOST_URL/api/v4/channels/CHANNEL_ID/restore" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN"
```

### 转换 public ↔ private

```bash
curl -s -X PUT "$MATTERMOST_URL/api/v4/channels/CHANNEL_ID/privacy" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"privacy": "P"}'  # O=public, P=private
```

---

## 成员管理

### 邀请用户到 channel

```bash
curl -s -X POST "$MATTERMOST_URL/api/v4/channels/CHANNEL_ID/members" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "USER_ID"}'
```

### 移除成员

```bash
curl -s -X DELETE "$MATTERMOST_URL/api/v4/channels/CHANNEL_ID/members/USER_ID" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN"
```

### 列出 channel 成员

```bash
curl -s "$MATTERMOST_URL/api/v4/channels/CHANNEL_ID/members?per_page=200" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" | jq '.[].user_id'
```

---

## 消息操作

### 发消息到任意 channel

```bash
curl -s -X POST "$MATTERMOST_URL/api/v4/posts" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channel_id": "CHANNEL_ID",
    "message": "Hello from the bot!"
  }' | jq '{id, channel_id}'
```

### 回复 thread

```bash
curl -s -X POST "$MATTERMOST_URL/api/v4/posts" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channel_id": "CHANNEL_ID",
    "root_id": "PARENT_POST_ID",
    "message": "Thread reply"
  }'
```

### Pin / Unpin

```bash
curl -s -X POST "$MATTERMOST_URL/api/v4/posts/POST_ID/pin" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN"

curl -s -X POST "$MATTERMOST_URL/api/v4/posts/POST_ID/unpin" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN"
```

### 编辑消息

```bash
curl -s -X PUT "$MATTERMOST_URL/api/v4/posts/POST_ID/patch" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Updated message text"}'
```

### 删除消息

```bash
curl -s -X DELETE "$MATTERMOST_URL/api/v4/posts/POST_ID" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN"
```

### 搜索消息

```bash
curl -s -X POST "$MATTERMOST_URL/api/v4/teams/TEAM_ID/posts/search" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"terms": "keyword", "is_or_search": false}' | jq '.order[] as $id | .posts[$id] | {id: .id, message: .message, channel_id: .channel_id}'
```

### 添加 Reaction

```bash
curl -s -X POST "$MATTERMOST_URL/api/v4/reactions" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "BOT_USER_ID", "post_id": "POST_ID", "emoji_name": "white_check_mark"}'
```

先用 `GET /users/me` 获取 bot 的 user_id。

---

## 用户

```bash
# 列出用户
curl -s "$MATTERMOST_URL/api/v4/users?per_page=100" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" | jq '.[] | {id, username, first_name, last_name, email}'

# 搜索用户
curl -s -X POST "$MATTERMOST_URL/api/v4/users/search" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"term": "alice"}' | jq '.[] | {id, username}'

# 获取单个用户
curl -s "$MATTERMOST_URL/api/v4/users/USER_ID" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" | jq '{id, username, first_name, email}'
```

---

## Team 管理

```bash
# 列出所有 team
curl -s "$MATTERMOST_URL/api/v4/teams" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" | jq '.[] | {id, name, display_name}'

# 创建 team
curl -s -X POST "$MATTERMOST_URL/api/v4/teams" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "new-team", "display_name": "New Team", "type": "O"}'

# 添加用户到 team
curl -s -X POST "$MATTERMOST_URL/api/v4/teams/TEAM_ID/members" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"team_id": "TEAM_ID", "user_id": "USER_ID"}'
```

---

## 文件上传

```bash
# 上传文件（multipart），返回 file_id
FILE_ID=$(curl -s -X POST "$MATTERMOST_URL/api/v4/files" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" \
  -F "channel_id=CHANNEL_ID" \
  -F "files=@/path/to/file.txt" | jq -r '.file_infos[0].id')

# 发消息附带文件
curl -s -X POST "$MATTERMOST_URL/api/v4/posts" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"channel_id\": \"CHANNEL_ID\", \"message\": \"See attached\", \"file_ids\": [\"$FILE_ID\"]}"
```

---

## Webhook 管理

### 创建 incoming webhook（外部系统推送到 Mattermost）

```bash
curl -s -X POST "$MATTERMOST_URL/api/v4/hooks/incoming" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channel_id": "CHANNEL_ID",
    "display_name": "GitHub Updates",
    "description": "Receives GitHub webhook events"
  }' | jq '{id, display_name}'
```

外部系统用返回的 webhook URL 推送消息。

### 列出 webhooks

```bash
curl -s "$MATTERMOST_URL/api/v4/hooks/incoming?per_page=100" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" | jq '.[] | {id, display_name, channel_id}'
```

---

## DM（私信）

```bash
# 创建 DM channel（bot 与某用户之间）
DM_ID=$(curl -s -X POST "$MATTERMOST_URL/api/v4/channels/direct" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '["BOT_USER_ID", "TARGET_USER_ID"]' | jq -r '.id')

# 发私信
curl -s -X POST "$MATTERMOST_URL/api/v4/posts" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"channel_id\": \"$DM_ID\", \"message\": \"Private notification\"}"
```

---

## 常用 ID 获取

```bash
# Bot 自己的 user_id
curl -s "$MATTERMOST_URL/api/v4/users/me" -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" | jq -r .id

# Team ID（通常只有一个）
curl -s "$MATTERMOST_URL/api/v4/teams" -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" | jq -r '.[0].id'

# Channel ID by name
curl -s "$MATTERMOST_URL/api/v4/teams/TEAM_ID/channels/name/town-square" \
  -H "Authorization: Bearer $MATTERMOST_BOT_TOKEN" | jq -r .id
```

---

## 代替用户执行 Slash Commands

使用 MCP tool `execute_command` 可以代替用户执行 Mattermost 斜杠命令。
用户必须先在与 bot 的私聊中执行 `/delegate` 授权后才能使用此功能。

命令在当前频道中执行，执行结果会作为消息出现在频道中。

只需传入 `command` 参数，用户 ID 和频道 ID 自动从上下文获取。

---

## 注意事项

- `channel.name` 必须全小写、字母数字连字符，≤64 字符
- 消息限制 16383 字符，超长需分割
- 归档的 channel 不能发消息，需先恢复
- 批量加人用 `POST /teams/{id}/members/batch`，body 为数组
- jq 可能不可用时改用 python3: `python3 -c "import sys,json; ..."`
