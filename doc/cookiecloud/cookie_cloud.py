# -*- coding: utf-8 -*-
"""
CookieCloud 客户端封装

负责从 CookieCloud 服务获取和解析 cookie 数据。
"""

import base64
import json
from dataclasses import dataclass
from typing import Optional

from ..log import logger


@dataclass
class ParsedCookies:
    """解析后的 cookie 数据"""

    authorization: str  # PROD_AUTH_TOKEN 的值
    cookie_string: str  # 完整 cookie 字符串
    jwt_exp: int  # JWT 过期时间戳


class CookieCloudClient:
    """
    CookieCloud 客户端

    负责从 CookieCloud 服务获取 cookie 数据，并解析出认证信息。
    """

    def __init__(self, url: str, uuid: str, password: str):
        """
        初始化 CookieCloud 客户端。

        Args:
            url: CookieCloud 服务地址
            uuid: CookieCloud UUID
            password: 解密密码
        """
        self.url = url.rstrip("/")
        self.uuid = uuid
        self.password = password

    def fetch_cookies(self, target_domain: str = ".duolainc.com") -> ParsedCookies:
        """
        从 CookieCloud 获取并解析 cookie。

        Args:
            target_domain: 目标域名

        Returns:
            ParsedCookies 包含解析后的认证信息

        Raises:
            ConnectionError: 连接 CookieCloud 失败
            ValueError: Cookie 数据格式错误或缺少必要字段
        """
        # 延迟导入，避免未安装时影响其他功能
        try:
            from PyCookieCloud import PyCookieCloud
        except ImportError:
            raise ImportError(
                "PyCookieCloud 未安装，请运行: uv add PyCookieCloud"
            )

        logger.info(f"从 CookieCloud 获取 cookie (目标域名: {target_domain})")

        # 临时禁用 SSL 验证以解决自签名证书问题
        import urllib3

        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

        try:
            # 使用 monkey-patch 禁用 SSL 验证
            import requests

            original_get = requests.get
            original_session_get = requests.Session.get

            def get_no_verify(*args, **kwargs):
                kwargs["verify"] = False
                return original_get(*args, **kwargs)

            def session_get_no_verify(self, *args, **kwargs):
                kwargs["verify"] = False
                return original_session_get(self, *args, **kwargs)

            requests.get = get_no_verify
            requests.Session.get = session_get_no_verify

            try:
                client = PyCookieCloud(self.url, self.uuid, self.password)
                decrypted_data = client.get_decrypted_data()
            finally:
                # 恢复原始方法
                requests.get = original_get
                requests.Session.get = original_session_get

        except Exception as e:
            logger.error(f"CookieCloud 连接失败: {e}")
            raise ConnectionError(f"CookieCloud 连接失败: {e}")

        if not decrypted_data:
            raise ConnectionError("CookieCloud 返回数据为空")

        logger.info(f"获取到 {len(decrypted_data)} 个域名的 cookie")
        logger.debug(f"可用域名: {list(decrypted_data.keys())}")

        # 提取目标域名的 cookie（支持带/不带前导点的域名格式）
        domain_cookies = self._find_domain_cookies(decrypted_data, target_domain)
        if not domain_cookies:
            available = list(decrypted_data.keys())
            raise ValueError(
                f"未找到域名 '{target_domain}' 的 cookie，可用域名: {available}"
            )

        logger.info(f"找到 {len(domain_cookies)} 个匹配的 cookie")

        # 解析 cookie
        return self._parse_cookies(domain_cookies)

    def _find_domain_cookies(
        self, data: dict[str, list], target_domain: str
    ) -> list[dict]:
        """
        在 CookieCloud 数据中查找匹配的域名 cookie。

        支持多种域名格式匹配：
        - 精确匹配
        - 带/不带前导点的变体（.duolainc.com vs duolainc.com）

        Args:
            data: CookieCloud 返回的数据 {domain: [cookies]}
            target_domain: 目标域名

        Returns:
            匹配的 cookie 列表
        """
        # 1. 精确匹配
        if target_domain in data:
            logger.debug(f"精确匹配域名: {target_domain}")
            return data[target_domain]

        # 2. 尝试变体匹配
        # 如果目标是 .duolainc.com，也尝试 duolainc.com
        # 如果目标是 duolainc.com，也尝试 .duolainc.com
        if target_domain.startswith("."):
            variant = target_domain[1:]  # 去掉前导点
        else:
            variant = "." + target_domain  # 添加前导点

        if variant in data:
            logger.debug(f"变体匹配域名: {variant} (目标: {target_domain})")
            return data[variant]

        # 3. 未找到匹配
        return []

    def _parse_cookies(self, cookies: list[dict]) -> ParsedCookies:
        """
        解析 cookie 列表，提取认证信息。

        Args:
            cookies: cookie 列表，每项包含 name, value 等字段

        Returns:
            ParsedCookies 包含解析后的认证信息

        Raises:
            ValueError: 缺少必要的 cookie 字段
        """
        cookie_parts = []
        authorization = None
        jwt_exp = None

        for cookie in cookies:
            name = cookie.get("name", "")
            value = cookie.get("value", "")

            if not name or not value:
                continue

            cookie_parts.append(f"{name}={value}")

            # 提取 PROD_AUTH_TOKEN
            if name == "PROD_AUTH_TOKEN":
                authorization = value
                jwt_exp = self._extract_jwt_exp(value)
                logger.info(f"找到 PROD_AUTH_TOKEN (exp: {jwt_exp})")

        if not authorization:
            raise ValueError("Cookie 中缺少 PROD_AUTH_TOKEN")

        if not jwt_exp:
            raise ValueError("无法从 PROD_AUTH_TOKEN 解析过期时间")

        cookie_string = "; ".join(cookie_parts)
        logger.info(f"Cookie 字符串长度: {len(cookie_string)}")

        return ParsedCookies(
            authorization=authorization,
            cookie_string=cookie_string,
            jwt_exp=jwt_exp,
        )

    def _extract_jwt_exp(self, jwt_token: str) -> Optional[int]:
        """
        从 JWT token 中提取过期时间。

        Args:
            jwt_token: JWT token 字符串

        Returns:
            过期时间戳（秒），解析失败返回 None
        """
        try:
            # JWT 格式: header.payload.signature
            parts = jwt_token.split(".")
            if len(parts) != 3:
                logger.warning(f"JWT 格式错误，应为 3 部分，实际为 {len(parts)} 部分")
                return None

            # Base64 解码 payload
            payload_b64 = parts[1]
            # 添加必要的填充
            padding = 4 - len(payload_b64) % 4
            if padding != 4:
                payload_b64 += "=" * padding

            payload_json = base64.b64decode(payload_b64)
            payload = json.loads(payload_json)

            exp = payload.get("exp")
            if exp:
                logger.debug(f"JWT exp: {exp}")
                return int(exp)

            logger.warning("JWT payload 中缺少 exp 字段")
            return None

        except Exception as e:
            logger.error(f"解析 JWT 失败: {e}")
            return None
