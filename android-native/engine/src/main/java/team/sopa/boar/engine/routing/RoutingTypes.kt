package team.sopa.boar.engine.routing

/**
 * A conceptual role in a routing plan, not a specific model (src/routing/types.ts ModelRole). Only one generation
 * context is resident at a time, so a plan using several roles runs them one after another, paying a real model
 * switch each time. [value] is the TypeScript string.
 */
enum class ModelRole(val value: String) {
    FAST("fast"),
    GENERAL("general"),
    REASONING("reasoning"),
    VERIFIER("verifier"),
    EMBEDDING("embedding"),
    ;

    companion object {
        fun of(value: String): ModelRole = entries.first { it.value == value }
    }
}

/** A named routing configuration the user picks (settings.ts routingPreset; "balanced" when unset). */
enum class RoutingPreset(val value: String) {
    SIMPLE("simple"),
    BALANCED("balanced"),
    RESEARCH("research"),
    CUSTOM("custom"),
    ;

    companion object {
        /** settings.ts getRoutingPreset's default. */
        val DEFAULT = BALANCED
        fun of(value: String): RoutingPreset = entries.first { it.value == value }
    }
}

/** One stage in an execution plan. */
enum class RoutingStepType(val value: String) {
    CLASSIFY("classify"),
    RETRIEVE("retrieve"),
    GENERATE("generate"),
    VERIFY("verify"),
    SYNTHESIZE("synthesize"),
    ;

    companion object {
        fun of(value: String): RoutingStepType = entries.first { it.value == value }
    }
}
