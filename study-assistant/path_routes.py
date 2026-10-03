"""PathRoutes HTTP routes use injected application services."""

import urllib.error
import material_parser
from background_jobs import JobError
from user_accounts import AccountError


class PathRoutes:
    def __init__(self, dispatch):
        self.dispatch = dispatch

    def post(self, request, path):
        try:
            body = request._read_body()
        except Exception as e:
            request._json(400, {"error": "bad json: %s" % e})
            return
        try:
            request._authorize_body(path, body)
            status, result = self.dispatch(path, body, request.actor)
            request._json(status, result)
        except (AccountError, JobError, material_parser.MaterialError) as error:
            request._json(error.status, {"ok": False, "error": str(error)})
        except urllib.error.HTTPError as e:
            request._json(502, {"error": "upstream HTTP %s" % e.code})
        except Exception as e:
            request._json(502, {"error": "%s: %s" % (type(e).__name__, e)})
        return
