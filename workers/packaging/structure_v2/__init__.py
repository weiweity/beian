"""PackagingStructure V2: semantic structure contracts and topology validation."""

from .model import (
    SCHEMA,
    StructureContractError,
    canonicalize_structure,
    load_structure,
    structure_cache_key,
)
from .adapters import AdaptationResult, StructureAdapterError, adapt_structure
from .artwork import ArtworkMappingError, render_face_assets
from .confirmation import StructureConfirmationError, confirm_structure
from .resolver import ResolutionResult, resolve_structure, resolve_structure_payload
from .topology import (
    TopologyError,
    analyze_declared_faces,
    analyze_topology,
    derive_face_proposal,
    derive_rectangular_face_proposal,
)

__all__ = [
    "SCHEMA",
    "AdaptationResult",
    "ArtworkMappingError",
    "ResolutionResult",
    "StructureAdapterError",
    "StructureContractError",
    "StructureConfirmationError",
    "TopologyError",
    "adapt_structure",
    "analyze_declared_faces",
    "analyze_topology",
    "canonicalize_structure",
    "confirm_structure",
    "derive_face_proposal",
    "derive_rectangular_face_proposal",
    "load_structure",
    "resolve_structure",
    "resolve_structure_payload",
    "render_face_assets",
    "structure_cache_key",
]
