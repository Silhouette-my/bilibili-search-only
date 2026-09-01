(function (global) {
  const MESSAGE_TYPES = Object.freeze({
    GET_STATE: 'BF_GET_STATE',
    ENSURE_RUNTIME: 'BF_ENSURE_RUNTIME',
    UPDATE_PREFERENCE: 'BF_UPDATE_PREFERENCE',
    SAVE_SETTINGS: 'BF_SAVE_SETTINGS',
    SET_SITE_BLOCK_OVERRIDE: 'BF_SET_SITE_BLOCK_OVERRIDE',
    START_FOCUS_SESSION: 'BF_START_FOCUS_SESSION',
    STOP_FOCUS_SESSION: 'BF_STOP_FOCUS_SESSION',
    ACTIVITY_PING: 'BF_ACTIVITY_PING',
    RESUME_BLOCKED_TAB: 'BF_RESUME_BLOCKED_TAB'
  });

  const ERROR_CODES = Object.freeze({
    INVALID_REQUEST: 'invalid_request',
    NOT_AUTHORIZED: 'not_authorized',
    CONFLICT: 'state_conflict',
    POLICY_REJECTED: 'policy_rejected',
    UNSUPPORTED_SCHEMA: 'unsupported_schema',
    INTERNAL_ERROR: 'internal_error'
  });

  function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function createSuccessResponse(snapshot, result = null) {
    return {
      ok: true,
      snapshot: snapshot || null,
      result
    };
  }

  function createErrorResponse(code, message, snapshot = null) {
    return {
      ok: false,
      error: {
        code: typeof code === 'string' && code ? code : ERROR_CODES.INTERNAL_ERROR,
        message: typeof message === 'string' && message ? message : '操作失败。'
      },
      snapshot: snapshot || null
    };
  }

  function getErrorMessage(response, fallback = '操作失败。') {
    if (!response || response.ok !== false) return fallback;
    if (typeof response.error === 'string' && response.error) return response.error;
    if (isRecord(response.error) && typeof response.error.message === 'string') {
      return response.error.message;
    }
    return fallback;
  }

  global.BiliFocusContracts = {
    MESSAGE_TYPES,
    ERROR_CODES,
    isRecord,
    createSuccessResponse,
    createErrorResponse,
    getErrorMessage
  };
})(globalThis);
