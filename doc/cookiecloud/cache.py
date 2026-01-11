# -*- coding: utf-8 -*-
"""
认证信息本地缓存管理

负责将认证凭据缓存到本地 JSON 文件，支持过期检测。
"""

import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional

from ..log import logger


@dataclass
class CachedAuth:
    """缓存的认证信息"""

    version: int  # 缓存格式版本
    created_at: float  # 创建时间戳
    jwt_exp: int  # JWT 过期时间戳（秒）
    authorization: str  # JWT token
    cookie_string: str  # 完整 cookie 字符串


class AuthCache:
    """
    认证信息缓存管理器

    将认证凭据缓存到本地 JSON 文件，支持：
    - 加载/保存缓存
    - 过期检测（提前 5 分钟）
    - 手动失效
    """

    CACHE_VERSION = 1
    # 提前 5 分钟刷新，避免临界过期
    REFRESH_BUFFER_SECONDS = 300

    def __init__(self, cache_path: str = "./data/cookie_cache.json"):
        """
        初始化缓存管理器。

        Args:
            cache_path: 缓存文件路径
        """
        self.cache_path = Path(cache_path)

    def load(self) -> Optional[CachedAuth]:
        """
        从文件加载缓存。

        Returns:
            CachedAuth 实例，文件不存在或格式错误时返回 None
        """
        if not self.cache_path.exists():
            logger.debug(f"缓存文件不存在: {self.cache_path}")
            return None

        try:
            with open(self.cache_path, "r", encoding="utf-8") as f:
                data = json.load(f)

            # 检查版本兼容性
            if data.get("version") != self.CACHE_VERSION:
                logger.warning(
                    f"缓存版本不匹配: {data.get('version')} != {self.CACHE_VERSION}"
                )
                return None

            return CachedAuth(
                version=data["version"],
                created_at=data["created_at"],
                jwt_exp=data["jwt_exp"],
                authorization=data["authorization"],
                cookie_string=data["cookie_string"],
            )
        except (json.JSONDecodeError, KeyError) as e:
            logger.warning(f"缓存文件格式错误: {e}")
            return None
        except Exception as e:
            logger.error(f"加载缓存失败: {e}")
            return None

    def save(self, auth: CachedAuth) -> bool:
        """
        保存缓存到文件。

        Args:
            auth: 认证信息

        Returns:
            是否保存成功
        """
        try:
            # 确保目录存在
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)

            with open(self.cache_path, "w", encoding="utf-8") as f:
                json.dump(asdict(auth), f, ensure_ascii=False, indent=2)

            logger.info(f"认证缓存已保存: {self.cache_path}")
            return True
        except Exception as e:
            logger.error(f"保存缓存失败: {e}")
            return False

    def is_valid(self, cached: CachedAuth) -> bool:
        """
        检查缓存是否有效（未过期）。

        提前 5 分钟判定为过期，避免临界情况。

        Args:
            cached: 缓存的认证信息

        Returns:
            是否有效
        """
        current_time = time.time()
        expire_time = cached.jwt_exp - self.REFRESH_BUFFER_SECONDS

        if current_time > expire_time:
            remaining = cached.jwt_exp - current_time
            logger.info(f"缓存已过期或即将过期，剩余 {remaining:.0f} 秒")
            return False

        remaining = expire_time - current_time
        logger.debug(f"缓存有效，距离刷新还有 {remaining:.0f} 秒")
        return True

    def invalidate(self) -> bool:
        """
        使缓存失效（删除缓存文件）。

        Returns:
            是否成功
        """
        try:
            if self.cache_path.exists():
                self.cache_path.unlink()
                logger.info(f"缓存已清除: {self.cache_path}")
            return True
        except Exception as e:
            logger.error(f"清除缓存失败: {e}")
            return False
