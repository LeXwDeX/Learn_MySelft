"""Persistent users and revocable sessions for isolated learning spaces.

Passwords and session tokens are never stored in plaintext. The initial admin
owns the existing u0 namespace; new users get immutable, server-generated IDs.
"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import tempfile
import threading
import time

COOKIE_NAME = 'learn_session'
SESSION_TTL = 7 * 24 * 60 * 60
USERNAME = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}$')
USER_ID = re.compile(r'^(?:u0|u[0-9a-f]{16})$')


class AccountError(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.scrypt(password.encode('utf-8'), salt=bytes.fromhex(salt), n=16384, r=8, p=1).hex()
    return {'salt': salt, 'digest': digest}


def password_matches(password, stored):
    if not isinstance(password, str) or len(password) > 256:
        return False
    return hmac.compare_digest(password_hash(password, stored['salt'])['digest'], stored['digest'])


def validate_password(password):
    if not isinstance(password, str) or not 8 <= len(password) <= 256:
        raise AccountError(400, '密码需为8至256个字符')
    return password


def public_user(user):
    return {key: user[key] for key in ('id', 'username', 'display_name', 'role', 'active', 'created')}


class AccountStore:
    def __init__(self, directory, bootstrap_password):
        self.directory = Path(directory)
        self.path = self.directory / 'accounts.json'
        self.lock = threading.RLock()
        self.failures = {}
        with self.lock:
            if self.path.exists():
                self.data = json.loads(self.path.read_text(encoding='utf-8'))
            else:
                if not bootstrap_password:
                    raise AccountError(503, '请先在服务器配置管理员初始密码')
                self.data = {'version': 1, 'users': {'u0': {
                    'id': 'u0', 'username': 'admin', 'display_name': '管理员', 'role': 'admin',
                    'active': True, 'created': int(time.time()), 'password': password_hash(bootstrap_password),
                    'session_version': 1}}, 'sessions': {}}
                self._save()
            self.dummy_password = self.data['users']['u0']['password']

    def _save(self):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor, temporary = tempfile.mkstemp(prefix='.accounts-', dir=self.directory)
        try:
            with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
                json.dump(self.data, output, ensure_ascii=False)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def _user(self, user_id):
        user = self.data['users'].get(user_id)
        if not user:
            raise AccountError(404, '用户不存在')
        return user

    def _require_admin(self, actor):
        current = self._user(actor['id'])
        if current['role'] != 'admin' or not current['active']:
            raise AccountError(403, '仅管理员可以管理用户')

    def get_user(self, user_id):
        with self.lock:
            return public_user(self._user(user_id))

    def list_users(self, actor):
        with self.lock:
            self._require_admin(actor)
            return [public_user(user) for user in self.data['users'].values()]

    def create_user(self, actor, username, display_name, password):
        if not isinstance(username, str) or not USERNAME.fullmatch(username):
            raise AccountError(400, '账号需为3至32位字母、数字、点、短横线或下划线')
        if not isinstance(display_name, str) or not 1 <= len(display_name.strip()) <= 60:
            raise AccountError(400, '显示名称需为1至60个字符')
        validate_password(password)
        with self.lock:
            self._require_admin(actor)
            if len(self.data['users']) >= 500:
                raise AccountError(400, '用户数量已达上限')
            if any(user['username'].casefold() == username.casefold() for user in self.data['users'].values()):
                raise AccountError(409, '账号已存在')
            user_id = 'u' + secrets.token_hex(8)
            user = {'id': user_id, 'username': username, 'display_name': display_name.strip(),
                    'role': 'user', 'active': True, 'created': int(time.time()),
                    'password': password_hash(password), 'session_version': 1}
            self.data['users'][user_id] = user
            self._save()
            return public_user(user)

    def _revoke_sessions(self, user):
        user['session_version'] += 1
        self.data['sessions'] = {key: value for key, value in self.data['sessions'].items() if value['user_id'] != user['id']}

    def update_user(self, actor, user_id, changes):
        if not isinstance(changes, dict) or set(changes) - {'display_name', 'active', 'password'}:
            raise AccountError(400, '不支持的用户修改字段')
        name, active, password = changes.get('display_name'), changes.get('active'), changes.get('password')
        if name is not None and (not isinstance(name, str) or not 1 <= len(name.strip()) <= 60):
            raise AccountError(400, '显示名称需为1至60个字符')
        if 'active' in changes and type(active) is not bool:
            raise AccountError(400, '用户状态必须为布尔值')
        if password is not None:
            validate_password(password)
        with self.lock:
            self._require_admin(actor)
            user = self._user(user_id)
            if user['role'] == 'admin' and active is False:
                raise AccountError(400, '不能停用管理员')
            if name is not None:
                user['display_name'] = name.strip()
            if active is not None:
                user['active'] = active
            if password is not None:
                user['password'] = password_hash(password)
            if password is not None or active is not None:
                self._revoke_sessions(user)
            self._save()
            return public_user(user)

    def change_password(self, actor, old_password, new_password):
        validate_password(new_password)
        with self.lock:
            user = self._user(actor['id'])
            if not password_matches(old_password, user['password']):
                raise AccountError(403, '当前密码错误')
            user['password'] = password_hash(new_password)
            self._revoke_sessions(user)
            self._save()

    def check_password(self, actor, password):
        with self.lock:
            return password_matches(password, self._user(actor['id'])['password'])

    def login(self, username, password, remote_address):
        if not isinstance(username, str) or not isinstance(password, str) or len(username) > 100 or len(password) > 256:
            raise AccountError(400, '账号或密码格式不正确')
        now = time.time()
        with self.lock:
            self.failures = {key: failure for key, failure in self.failures.items() if failure['until'] > now}
            # Bound attempts by source as well as account to prevent username rotation.
            limit_keys = ['ip:' + remote_address, 'name:' + username.casefold()]
            if any(self.failures.get(key, {}).get('count', 0) >= 10 for key in limit_keys):
                raise AccountError(429, '尝试次数过多，请5分钟后再试')
            user = next((u for u in self.data['users'].values() if u['username'].casefold() == username.casefold()), None)
            matches = password_matches(password, user['password'] if user else self.dummy_password)
            if not user or not matches or not user['active']:
                for key in limit_keys:
                    failed = self.failures.setdefault(key, {'count': 0, 'until': now + 300})
                    failed['count'] += 1
                raise AccountError(401, '账号或密码错误，或用户已停用')
            for key in limit_keys:
                self.failures.pop(key, None)
            token = secrets.token_urlsafe(32)
            identity = hashlib.sha256(token.encode()).hexdigest()
            self.data['sessions'] = {key: session for key, session in self.data['sessions'].items() if session['expires'] > now}
            # Retain a bounded number of live sessions per user.
            own = sorted((key for key, session in self.data['sessions'].items() if session['user_id'] == user['id']),
                         key=lambda key: self.data['sessions'][key]['expires'])
            for key in own[:-19]:
                self.data['sessions'].pop(key)
            self.data['sessions'][identity] = {'user_id': user['id'], 'version': user['session_version'], 'expires': now + SESSION_TTL}
            self._save()
            return public_user(user), token

    def authenticate(self, token):
        if not isinstance(token, str) or not token or len(token) > 100:
            raise AccountError(401, '请先登录')
        with self.lock:
            session = self.data['sessions'].get(hashlib.sha256(token.encode()).hexdigest())
            if not session or session['expires'] <= time.time():
                raise AccountError(401, '登录已失效，请重新登录')
            user = self._user(session['user_id'])
            if not user['active'] or session['version'] != user['session_version']:
                raise AccountError(401, '登录已失效，请重新登录')
            return public_user(user)

    def logout(self, token):
        with self.lock:
            self.data['sessions'].pop(hashlib.sha256(token.encode()).hexdigest(), None)
            self._save()

    def authorize_target(self, actor, user_id, write=False):
        if not isinstance(user_id, str) or not USER_ID.fullmatch(user_id):
            raise AccountError(400, '无效的用户路径')
        with self.lock:
            target = self._user(user_id)
            if actor['id'] == user_id:
                if not target['active']:
                    raise AccountError(403, '用户已停用')
                return public_user(target)
            if actor['role'] != 'admin' or write:
                raise AccountError(403, '不能访问其他用户的资料' if actor['role'] != 'admin' else '查看其他用户资料时只读')
            return public_user(target)
