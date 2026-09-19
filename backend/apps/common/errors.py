"""service 層が投げる業務エラー。view では捕まえずに投げっぱなしでよい
（config/exceptions.py が HTTP 応答に変換する）。"""


class DomainError(Exception):
    code = "domain_error"
    status = 400

    def __init__(self, message: str, code: str | None = None, status: int | None = None):
        super().__init__(message)
        if code:
            self.code = code
        if status:
            self.status = status


class NotFound(DomainError):
    code = "not_found"
    status = 404


class Conflict(DomainError):
    code = "conflict"
    status = 409
