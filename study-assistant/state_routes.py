"""StateRoutes HTTP routes use injected application services."""

from state_store import StateConflict
from user_accounts import AccountError


class StateRoutes:
    def __init__(self, repository, accounts):
        self.repository = repository
        self.accounts = accounts

    def post(self, request, path):
        try:
            body = request._read_body()
            request._authorize_body(path, body)
            if not isinstance(body, dict):
                raise ValueError("body must be an object")
            if path == "/state/put":
                entries = body.get("entries")
                if not isinstance(entries, dict):
                    raise ValueError("entries must be an object")
            else:
                keys = body.get("keys")
                if not isinstance(keys, list) or not all(
                    (isinstance(k, str) for k in keys)
                ):
                    raise ValueError("keys must be an array of strings")
                entries = dict.fromkeys(keys)
            if any((v is None for v in entries.values())):
                password = body.get("password")
                if not self.accounts.check_password(request.actor, password):
                    request._json(403, {"ok": False, "error": "密码错误"})
                    return
            n = self.repository.put_entries(entries, expected=body.get("expected"))
            request._json(200, {"ok": True, "n": n})
        except AccountError as e:
            request._json(e.status, {"ok": False, "error": str(e)})
        except StateConflict as e:
            request._json(409, {"ok": False, "error": str(e)})
        except (ValueError, TypeError) as e:
            request._json(400, {"ok": False, "error": str(e)})
        except Exception as e:
            request._json(500, {"ok": False, "error": str(e)})
        return
