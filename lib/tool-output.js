/** 工具返回值的统一形状（与宿主 v2 工具协议一致）。 */

export function toToolResult(payload, text) {
  return {
    content: [{ type: "text", text: text || JSON.stringify(payload, null, 2) }],
    details: { data: payload },
  };
}

export function toToolError(message, data = {}) {
  return {
    content: [{ type: "text", text: `本地向量记忆：${message}` }],
    details: { data: { ok: false, error: message, ...data } },
    isError: true,
  };
}
