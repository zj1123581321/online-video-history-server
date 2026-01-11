# -*- coding: utf-8 -*-
"""
认证提供者

统一管理认证信息的获取，支持：
- CookieCloud 自动获取
- 本地缓存
- 静态配置降级
"""

import time
from dataclasses import dataclass
from typing import Optional

from ..log import logger
from ..notifier import send_failure
from .cache import AuthCache, CachedAuth
from .cookie_cloud import CookieCloudClient


@dataclass
class AuthCredentials:
    """认证凭据"""

    authorization: str  # JWT token (用于 Authorization header)
    cookie: str  # 完整 cookie 字符串


class AuthProvider:
    """
    认证提供者

    统一管理认证信息的获取，支持多种来源和降级策略：
    1. CookieCloud 自动获取（启用时优先）
    2. 本地缓存（避免频繁请求）
    3. config.yaml 静态配置（降级方案）

    使用示例:
        ```python
        auth_provider = AuthProvider(config)
        auth = auth_provider.get_auth()

        api_client = IMApiClient(
            authorization=auth.authorization,
            cookie=auth.cookie,
        )
        ```
    """

    def __init__(self, config: dict, cache_path: str = "./data/cookie_cache.json"):
        """
        初始化认证提供者。

        Args:
            config: 完整配置字典，包含 auth 和可选的 cookiecloud 配置
            cache_path: 缓存文件路径
        """
        self.config = config
        self.cache = AuthCache(cache_path)

        # 初始化 CookieCloud 客户端（如果配置了）
        self._cookie_cloud: Optional[CookieCloudClient] = None

        cc_config = config.get("cookiecloud", {})
        if cc_config.get("enabled"):
            self._cookie_cloud = CookieCloudClient(
                url=cc_config.get("url", ""),
                uuid=cc_config.get("uuid", ""),
                password=cc_config.get("password", ""),
            )
            self._target_domain = cc_config.get("target_domain", ".duolainc.com")

    def is_cookiecloud_enabled(self) -> bool:
        """检查 CookieCloud 是否启用"""
        return self._cookie_cloud is not None

    def get_auth(self) -> AuthCredentials:
        """
        获取认证信息。

        优先级：
        1. CookieCloud 启用时：缓存 → CookieCloud → 静态配置降级
        2. CookieCloud 未启用时：直接使用静态配置

        Returns:
            AuthCredentials 包含 authorization 和 cookie

        Raises:
            ValueError: 静态配置也不可用时抛出
        """
        # CookieCloud 未启用，直接使用静态配置
        if not self.is_cookiecloud_enabled():
            logger.debug("CookieCloud 未启用，使用静态配置")
            return self._get_static_auth()

        # 1. 检查本地缓存
        cached = self.cache.load()
        if cached and self.cache.is_valid(cached):
            logger.info("使用本地缓存的认证信息")
            return AuthCredentials(
                authorization=cached.authorization,
                cookie=cached.cookie_string,
            )

        # 2. 从 CookieCloud 获取
        try:
            auth = self._fetch_from_cookiecloud()

            # 保存到缓存
            self._save_to_cache(auth)

            return auth

        except Exception as e:
            logger.error(f"CookieCloud 获取失败: {e}")

            # 发送告警通知（使用全局企微通知器）
            send_failure(
                title="IM Parser 认证告警",
                error_message=f"**来源**: CookieCloud\n**详情**: {e}\n**状态**: 已降级到静态配置",
                suggestions=[
                    "检查 CookieCloud 服务状态",
                    "确认浏览器已登录 duolainc.com",
                    "手动同步 CookieCloud 数据",
                    "检查 config.yaml 静态配置是否有效",
                ],
                mention_all=True,
            )

            # 3. 降级到静态配置
            logger.warning("降级到静态配置")
            return self._get_static_auth()

    def refresh(self, force: bool = False) -> AuthCredentials:
        """
        刷新认证信息。

        Args:
            force: 是否强制刷新（忽略缓存）

        Returns:
            AuthCredentials 包含 authorization 和 cookie
        """
        if force:
            logger.info("强制刷新认证信息，清除缓存")
            self.cache.invalidate()

        return self.get_auth()

    def invalidate(self) -> None:
        """使缓存失效"""
        self.cache.invalidate()

    def _get_static_auth(self) -> AuthCredentials:
        """
        从静态配置获取认证信息。

        Returns:
            AuthCredentials

        Raises:
            ValueError: 配置不完整时抛出
        """
        auth_config = self.config.get("auth", {})
        authorization = auth_config.get("authorization", "")
        cookie = auth_config.get("cookie", "")

        if not authorization or not cookie:
            raise ValueError(
                "静态认证配置不完整，请检查 config.yaml 中的 auth.authorization 和 auth.cookie"
            )

        return AuthCredentials(authorization=authorization, cookie=cookie)

    def _fetch_from_cookiecloud(self) -> AuthCredentials:
        """
        从 CookieCloud 获取认证信息。

        Returns:
            AuthCredentials

        Raises:
            Exception: 获取或解析失败时抛出
        """
        if not self._cookie_cloud:
            raise RuntimeError("CookieCloud 未配置")

        parsed = self._cookie_cloud.fetch_cookies(self._target_domain)

        return AuthCredentials(
            authorization=parsed.authorization,
            cookie=parsed.cookie_string,
        )

    def _save_to_cache(self, auth: AuthCredentials) -> None:
        """
        保存认证信息到缓存。

        Args:
            auth: 认证凭据
        """
        if not self._cookie_cloud:
            return

        # 从 CookieCloud 最后一次获取的数据中提取 jwt_exp
        # 这里需要重新解析 JWT 来获取 exp
        from .cookie_cloud import CookieCloudClient

        client = CookieCloudClient("", "", "")  # 只用于解析
        jwt_exp = client._extract_jwt_exp(auth.authorization)

        if not jwt_exp:
            logger.warning("无法提取 JWT 过期时间，跳过缓存")
            return

        cached = CachedAuth(
            version=AuthCache.CACHE_VERSION,
            created_at=time.time(),
            jwt_exp=jwt_exp,
            authorization=auth.authorization,
            cookie_string=auth.cookie,
        )

        self.cache.save(cached)
