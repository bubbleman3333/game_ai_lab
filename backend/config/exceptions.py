"""API のエラー応答を {"error": {"code", "message", "detail"}} の形にそろえる。"""

from rest_framework.views import exception_handler as drf_exception_handler

from apps.common.errors import DomainError


def exception_handler(exc, context):
    if isinstance(exc, DomainError):
        from rest_framework.response import Response

        return Response({"error": {"code": exc.code, "message": str(exc), "detail": None}}, status=exc.status)

    response = drf_exception_handler(exc, context)
    if response is not None:
        detail = response.data
        message = detail.get("detail") if isinstance(detail, dict) and "detail" in detail else "入力が正しくありません"
        response.data = {
            "error": {"code": getattr(exc, "default_code", "error"), "message": str(message), "detail": detail}
        }
    return response
