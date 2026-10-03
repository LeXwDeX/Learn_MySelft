"""Account HTTP routes and administrator overview."""

import json
from user_accounts import COOKIE_NAME, SESSION_TTL


class AccountRoutes:
    def __init__(self, accounts, repository):
        self.accounts = accounts
        self.repository = repository

    def overview(self, actor):
        users = self.accounts.list_users(actor)
        for user in users:
            stats = {"maps": 0, "quizzes": 0, "completed_nodes": 0, "total_nodes": 0}
            for key, value in self.repository.all(user["id"]).items():
                try:
                    material = json.loads(value) if isinstance(value, str) else None
                except ValueError:
                    continue
                if not isinstance(material, dict):
                    continue
                business = key.split("/", 1)[1]
                if (
                    business.startswith("learn-path-v1-")
                    and business != "learn-path-v1-last"
                ):
                    stats["maps"] += 1
                    plan = (
                        material.get("plan")
                        if isinstance(material.get("plan"), dict)
                        else {}
                    )
                    nodes = (
                        plan.get("nodes") if isinstance(plan.get("nodes"), list) else []
                    )
                    states = (
                        material.get("nodeState")
                        if isinstance(material.get("nodeState"), dict)
                        else {}
                    )
                    stats["total_nodes"] += len(nodes)
                    stats["completed_nodes"] += sum(
                        (
                            bool(node.get("completed"))
                            for node in states.values()
                            if isinstance(node, dict)
                        )
                    )
                elif business.startswith("quiz-map-v1-"):
                    stats["quizzes"] += 1
            user["stats"] = stats
        return users

    def post(self, request, path, body):
        store = self.accounts
        if path == "/auth/login":
            user, token = store.login(
                body.get("username"), body.get("password"), request.client_address[0]
            )
            request.session_cookie = (
                "%s=%s; Path=/; HttpOnly; SameSite=Strict; Max-Age=%d"
                % (COOKIE_NAME, token, SESSION_TTL)
            )
            request._json(200, {"ok": True, "user": user})
            return
        if path == "/auth/logout":
            store.logout(request._session_token())
            request.session_cookie = (
                COOKIE_NAME + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
            )
            request._json(200, {"ok": True})
            return
        request._authenticate()
        if path == "/auth/password":
            store.change_password(
                request.actor, body.get("old_password"), body.get("new_password")
            )
            request.session_cookie = (
                COOKIE_NAME + "=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
            )
            request._json(200, {"ok": True})
        elif path == "/admin/users/create":
            user = store.create_user(
                request.actor,
                body.get("username"),
                body.get("display_name"),
                body.get("password"),
            )
            request._json(201, {"ok": True, "user": user})
        elif path == "/admin/users/update":
            user = store.update_user(
                request.actor, body.get("user_id"), body.get("changes")
            )
            request._json(200, {"ok": True, "user": user})
        else:
            request._json(404, {"error": "not found"})
