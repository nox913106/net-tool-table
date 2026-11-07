"""
Pydantic Models for Tool Table API
"""
import re
from datetime import datetime
from typing import List, Optional

from pydantic import BaseModel, Field, field_validator

# Schemes that would run code in the browser when the link is clicked
_BLOCKED_SCHEMES = ("javascript:", "data:", "vbscript:")


def unsafe_url(url: Optional[str]) -> bool:
    if not url:
        return False
    # browsers ignore whitespace / control characters inside the scheme ("java\tscript:")
    compact = re.sub(r"[\x00-\x20]", "", url).lower()
    return compact.startswith(_BLOCKED_SCHEMES)


def check_url(url: Optional[str]) -> Optional[str]:
    if url is None:
        return None
    if unsafe_url(url):
        raise ValueError("不允許的網址類型（javascript:、data:、vbscript:）")
    return url.strip()

# ============ Node Models ============

class NodeBase(BaseModel):
    """Base node model with common fields"""
    name: str = Field(..., min_length=1, max_length=200)
    node_type: str = Field(..., pattern="^(folder|link)$")
    icon: Optional[str] = None
    url: Optional[str] = None
    description: Optional[str] = None
    color: Optional[str] = Field(None, pattern=r"^(#[0-9a-fA-F]{6})?$")   # per-item accent, e.g. "#22c55e"
    launch_args: Optional[str] = Field(None, max_length=2000)   # local program arguments
    launch_cwd: Optional[str] = Field(None, max_length=1024)    # local program working folder
    new_tab: bool = True
    sort_order: int = 0
    is_active: bool = True

    _check_url = field_validator("url")(lambda cls, v: check_url(v))


class NodeCreate(NodeBase):
    """Model for creating a new node"""
    parent_id: Optional[int] = None
    code: Optional[str] = None  # Auto-generate if not provided

class NodeUpdate(BaseModel):
    """Model for updating a node"""
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    node_type: Optional[str] = Field(None, pattern="^(folder|link)$")
    icon: Optional[str] = None
    url: Optional[str] = None
    description: Optional[str] = None
    color: Optional[str] = Field(None, pattern=r"^(#[0-9a-fA-F]{6})?$")
    launch_args: Optional[str] = Field(None, max_length=2000)
    launch_cwd: Optional[str] = Field(None, max_length=1024)
    new_tab: Optional[bool] = None
    sort_order: Optional[int] = None
    is_active: Optional[bool] = None

    _check_url = field_validator("url")(lambda cls, v: check_url(v))


class NodeMove(BaseModel):
    """Model for moving a node"""
    new_parent_id: Optional[int] = None

class NodeResponse(NodeBase):
    """Response model for a node"""
    id: int
    parent_id: Optional[int]
    code: str
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True

class NodeTreeItem(NodeResponse):
    """Node with children for tree structure"""
    children: List["NodeTreeItem"] = []

class NodeReorder(BaseModel):
    """Model for batch reordering"""
    items: List[dict]  # [{id: 1, sort_order: 0}, ...]

# ============ Auth Link Models ============

class AuthLinkBase(BaseModel):
    """Base quick-link model (region = optional group name)"""
    region: str = Field("", max_length=100)
    name: str = Field(..., min_length=1, max_length=200)
    url: str = Field(..., min_length=1)
    sort_order: int = 0
    is_active: bool = True

    _check_url = field_validator("url")(lambda cls, v: check_url(v))


class AuthLinkCreate(AuthLinkBase):
    """Model for creating auth link"""
    pass

class AuthLinkUpdate(BaseModel):
    """Model for updating auth link"""
    region: Optional[str] = None
    name: Optional[str] = None
    url: Optional[str] = None
    sort_order: Optional[int] = None
    is_active: Optional[bool] = None

    _check_url = field_validator("url")(lambda cls, v: check_url(v))


class AuthLinkResponse(AuthLinkBase):
    """Response model for auth link"""
    id: int
    created_at: Optional[datetime] = None

    class Config:
        from_attributes = True

class AuthLinkGroup(BaseModel):
    """Auth links grouped by region"""
    region: str
    items: List[AuthLinkResponse]

# ============ Search Models ============

class SearchResult(BaseModel):
    """Search result item"""
    id: int
    name: str
    node_type: str
    icon: Optional[str]
    url: Optional[str]
    code: str
    path: str  # Full path like "工具 > 監控 > Grafana"

# ============ API Response Models ============

class APIResponse(BaseModel):
    """Generic API response"""
    success: bool
    message: str
    data: Optional[dict] = None
