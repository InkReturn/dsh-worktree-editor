/**
 * cs-hub 的 host 侧统一错误类型。
 *
 * 所有可预期失败都携带稳定错误码（`cs-hub/*` 命名空间），由端点分派层转成
 * RPC 失败信封 `{ok:false, error:{code,message,details}}`；客户端按 `code` 分支，绝不匹配 message。
 * 契约 v2 §4.2：`server-unavailable` 已删除（服务层存活由 client 探 healthz 判定）。
 */

/** 跨 wire 的稳定业务错误；未知异常不会伪装成这个类型。 */
export class CsHubError extends Error {
  /**
   * @param {string} code 稳定错误码（如 `cs-hub/root-missing`），客户端按它分支。
   * @param {string} message 人类可读诊断（简体中文，可直接展示）。
   * @param {object} [details] 结构化补充信息，必须 JSON 可序列化。
   * @param {ErrorOptions} [options] 标准 Error 选项；`cause` 仅进程内保留，不上 wire。
   */
  constructor(code, message, details = {}, options) {
    // 1. 保留标准 Error 语义，附加稳定码与详情。
    super(message, options);
    this.name = 'CsHubError';
    this.code = code;
    this.details = details;
  }

  /**
   * 转换为 RPC 失败信封的 error 段。
   * @returns {{code: string, message: string, details: object}} wire 失败形状。
   */
  toWire() {
    // 1. 只输出协议要求的三个字段，不透传 cause/stack。
    return { code: this.code, message: this.message, details: this.details };
  }
}

/**
 * 契约 v2 §4.2 的全部合法**可抛**错误码（供静态检查与文档对照）。
 *
 * 注意：`registry-conflict` **不在这里**——它是 SSE 事件名（同 folder 归属转移提示），
 * host 从不把它当 RPC 错误抛出（契约 §4.2.1 已标注「不是可抛错误码」，T11 / minor-6 删除死定义）。
 */
export const ERROR_CODES = Object.freeze([
  'cs-hub/unknown-endpoint',
  'cs-hub/invalid-payload',
  'cs-hub/session-not-found',
  'cs-hub/root-uncertain',
  'cs-hub/root-missing',
  'cs-hub/internal',
]);
