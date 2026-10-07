package team.sopa.boar.engine.routing

import team.sopa.boar.engine.models.CatalogAsset
import team.sopa.boar.engine.models.Compatibility

/**
 * Model profiles and presets (port of src/routing/profiles.ts): given what is actually downloaded, which model fills
 * each role. Configuration only: it doesn't decide when to switch models, only what is available to switch to. Does
 * not require three models.
 */
object Profiles {
    data class ModelProfile(
        /** "" when the role could not be resolved (enabled = false). */
        val modelId: String,
        val role: ModelRole,
        val enabled: Boolean,
        /** True if this came from an explicit user role assignment, false if auto-resolved. */
        val userOverride: Boolean,
        val estimatedMemoryMb: Double? = null,
        val estimatedTokensPerSecond: Double? = null,
        val compatibilityStatus: Compatibility,
    )

    enum class RoleNeed { REQUIRED, OPTIONAL }

    /**
     * Which roles a preset uses, in declaration order (the order of the returned profiles), and whether each is
     * required or optional. Simple is one model (today's single-pass chat); Custom has no fixed roles.
     */
    val PRESET_DEFINITIONS: Map<RoutingPreset, List<Pair<ModelRole, RoleNeed>>> = mapOf(
        RoutingPreset.SIMPLE to listOf(ModelRole.GENERAL to RoleNeed.REQUIRED),
        RoutingPreset.BALANCED to listOf(
            ModelRole.GENERAL to RoleNeed.REQUIRED, ModelRole.FAST to RoleNeed.OPTIONAL, ModelRole.EMBEDDING to RoleNeed.OPTIONAL,
        ),
        RoutingPreset.RESEARCH to listOf(
            ModelRole.REASONING to RoleNeed.REQUIRED, ModelRole.GENERAL to RoleNeed.OPTIONAL,
            ModelRole.VERIFIER to RoleNeed.OPTIONAL, ModelRole.EMBEDDING to RoleNeed.OPTIONAL,
        ),
        RoutingPreset.CUSTOM to emptyList(),
    )

    /** A model is available for routing once it is on disk, not just in the catalog. */
    data class AvailableModel(val model: CatalogAsset, val present: Boolean)

    /**
     * Resolves a role to a downloaded model: 1. the user's override for the role, if present on disk; 2. the first
     * present model whose curated capabilities list the role; 3. the active/default model ([fallbackModelId]) if
     * present (flagged: its capabilities don't list the role); 4. an explicit disabled profile. Never throws and never
     * routes to a model that isn't on disk. Empty ids count as unset, as in JavaScript.
     */
    fun resolveModelForRole(
        role: ModelRole,
        available: List<AvailableModel>,
        overrides: Map<ModelRole, String>,
        deviceRamBytes: Long,
        fallbackModelId: String? = null,
    ): ModelProfile {
        val presentModels = available.filter { it.present }.map { it.model }
        // new Map(entries): the last entry with a given id wins.
        val presentById = HashMap<String, CatalogAsset>().apply { presentModels.forEach { put(it.id, it) } }

        val overrideId = overrides[role]
        if (!overrideId.isNullOrEmpty() && overrideId in presentById) {
            return toProfile(presentById.getValue(overrideId), role, true, deviceRamBytes)
        }

        val curated = presentModels.firstOrNull { it.capabilities?.roles?.contains(role.value) == true }
        if (curated != null) return toProfile(curated, role, false, deviceRamBytes)

        if (!fallbackModelId.isNullOrEmpty() && fallbackModelId in presentById) {
            return toProfile(presentById.getValue(fallbackModelId), role, false, deviceRamBytes)
        }

        return ModelProfile(modelId = "", role = role, enabled = false, userOverride = false, compatibilityStatus = Compatibility.UNKNOWN)
    }

    private fun toProfile(model: CatalogAsset, role: ModelRole, userOverride: Boolean, deviceRamBytes: Long) = ModelProfile(
        modelId = model.id,
        role = role,
        enabled = true,
        userOverride = userOverride,
        estimatedMemoryMb = model.capabilities?.estimatedMemoryMb ?: JsNumber.round((model.sizeBytes.toDouble() * 1.15) / (1024 * 1024)),
        estimatedTokensPerSecond = model.capabilities?.estimatedTokensPerSecond,
        compatibilityStatus = Compatibility.compute(model.sizeBytes, deviceRamBytes),
    )

    /**
     * Every role the preset uses, resolved. Roles that can't be resolved are still returned (enabled = false), so the
     * caller can show why the preset isn't fully functional instead of silently missing a step.
     */
    fun buildModelProfiles(
        preset: RoutingPreset,
        available: List<AvailableModel>,
        overrides: Map<ModelRole, String>,
        deviceRamBytes: Long,
        fallbackModelId: String? = null,
    ): List<ModelProfile> =
        PRESET_DEFINITIONS.getValue(preset).map { (role, _) -> resolveModelForRole(role, available, overrides, deviceRamBytes, fallbackModelId) }
}
