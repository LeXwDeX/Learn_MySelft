"""Explicit composition root for learning services, routes and background jobs."""

import os
import threading
from pathlib import Path
from http.server import ThreadingHTTPServer

from app_config import Settings
from background_jobs import JobQueue, JobError
from user_accounts import AccountStore
from state_store import StateStore
from material_repository import MaterialRepository
from generation_cache import GenerationCache
from model_client import ModelClient
from quiz_generation import QuizGeneration
from learning_service import LearningService
from quiz_service import QuizService
from flywheel_service import FlywheelService
from request_auth import RequestAuthorization
from account_routes import AccountRoutes
from material_routes import MaterialRoutes
from job_routes import JobRoutes
from state_routes import StateRoutes
from path_routes import PathRoutes
from tutor_routes import TutorRoutes
from http_handler import Handler
from tutor_rendering import TutorRendering
from render_review import validate_mermaid
from scene_service import SceneService
from manim_renderer import ManimRenderer
from manimgx_renderer import ManimgxRenderer
from manim_service import ManimService
from manim_routes import ManimRoutes
from job_execution import check_deadline


class Application:
    """Own one environment's stores and pass dependencies to each service."""

    def __init__(
        self,
        settings,
        *,
        initial_password="",
        model_key="",
        reasoning_effort="max",
        search_engines="brave,google cse,wikipedia",
    ):
        self.settings = settings
        self.accounts = AccountStore(settings.state_dir + "-accounts", initial_password)
        self.repository = MaterialRepository(StateStore(
            settings.state_dir, diagnostic_secrets=(model_key, initial_password)))
        self.cache = GenerationCache()
        self.model = ModelClient(settings, model_key, reasoning_effort, search_engines,
                                 detail_store=self.repository.store)
        self.verification = QuizGeneration(self.model)
        self.authorization = RequestAuthorization(self.accounts)
        self.tutor_rendering = TutorRendering(validate_mermaid)
        renderer = ManimgxRenderer(settings.state_dir) if settings.manim_engine == 'manimgx' \
            else ManimRenderer(settings.state_dir)
        self.manim = ManimService(self.repository, self.model, renderer, self.authorize_scene,
                                  authorize_read=self.authorize_asset,
                                  generation_token_limit=min(settings.max_output_tokens, 16384),
                                  engine=settings.manim_engine)
        self.scenes = SceneService(self.repository, self.model, self.verification,
                                   self.authorize_scene, manim=self.manim)
        dependencies = (self.repository, self.model, self.cache, self.verification)
        self.learning = LearningService(*dependencies, scenes=self.scenes)
        self.quizzes = QuizService(*dependencies)
        self.flywheel = FlywheelService(*dependencies)
        self.operations = {
            "/path/intake": self.learning.intake,
            "/path/research": self.learning.research,
            "/path/plan": self.learning.plan,
            "/path/node": self.learning.node,
            "/path/node/scene": self.scenes.supplement,
            "/path/requiz": self.quizzes.requiz,
            "/path/quizmap": self.quizzes.quizmap,
            "/path/quiz/state": self.quizzes.quiz_state_or_draft,
            "/path/quiz/draft": self.quizzes.quiz_state_or_draft,
            "/path/quiz": self.quizzes.quiz,
            "/path/gaps": self.flywheel.gaps,
            "/path/refine": self.flywheel.refine,
        }
        self.account_routes = AccountRoutes(self.accounts, self.repository)
        self.routes = {
            "materials": MaterialRoutes(self.repository),
            "jobs": JobRoutes(self.repository, self.jobs),
            "state": StateRoutes(self.repository, self.accounts),
            "path": PathRoutes(self.dispatch),
            "tutor": TutorRoutes(self.model),
            "manim": ManimRoutes(self.manim),
        }
        self._queue = None
        self._queue_lock = threading.Lock()

    def authorize_scene(self, actor, key):
        current = self.accounts.get_user(actor["id"])
        self.authorization.body(current, current["id"], "/path/node/scene", {"key": key})

    def authorize_asset(self, actor, key):
        current = self.accounts.get_user(actor["id"])
        self.authorization.key(current, key.split("/", 1)[0], key, write=False)

    def dispatch(self, operation, body, actor):
        handler = self.operations.get(operation)
        if handler is None:
            raise JobError(404, "不支持的学习操作")
        return handler(operation, body, actor)

    def run_job(self, user_id, operation, body):
        check_deadline()
        self.repository.store.job_progress(1, '核对用户与学习资料', total=5)
        actor = self.accounts.get_user(user_id)
        if not actor["active"]:
            raise JobError(403, "用户已停用，任务未执行")
        self.authorization.body(actor, user_id, operation, body)
        if self.repository.material(body["key"]) is None:
            raise JobError(404, "学习资料已删除或不存在，任务未执行")
        labels = {'/path/intake': '整理学习需求', '/path/research': '检索和核验参考来源',
                  '/path/plan': '生成学习路径', '/path/node': '生成单元内容',
                  '/path/node/scene': '生成教学动画', '/path/requiz': '生成并校验新题',
                  '/path/quizmap': '生成并校验综合测验', '/path/refine': '生成补习路径',
                  '/path/gaps': '诊断学习缺漏', '/path/quiz': '评估作答'}
        self.repository.store.job_progress(2, labels.get(operation, '处理学习任务'), total=5)
        if operation == '/path/node':
            # The callback raises the deadline error; it must not become a 409.
            return self.learning.node(operation, body, actor, cancelled=check_deadline)
        return self.dispatch(operation, body, actor)

    def jobs(self):
        with self._queue_lock:
            if self._queue is None:
                self._queue = JobQueue(
                    self.repository.store,
                    self.run_job,
                    self.settings.job_workers,
                    self.settings.job_queue_limit,
                )
                self._queue.start()
            return self._queue

    def close(self):
        if self._queue is not None:
            self._queue.stop()

    @staticmethod
    def release_revision():
        try:
            return (
                (Path(__file__).parent / "REVISION")
                .read_text(encoding="utf-8")
                .strip()[:64]
            )
        except OSError:
            return "development"

    def server(self, address=("0.0.0.0", None)):
        host, port = address
        server = ThreadingHTTPServer(
            (host, self.settings.port if port is None else port), Handler
        )
        server.application = self
        server.daemon_threads = True
        return server


def create_application(env=None):
    env = os.environ if env is None else env
    return Application(
        Settings.from_env(env),
        initial_password=env.get("DELETE_PASSWORD", ""),
        model_key=env.get("LLM_KEY", ""),
        reasoning_effort=env.get("REASONING_EFFORT", "max"),
        search_engines=env.get("SEARXNG_ENGINES", "brave,google cse,wikipedia").strip(),
    )
