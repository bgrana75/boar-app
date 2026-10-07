package team.sopa.boar.engine.routing

import team.sopa.boar.engine.routing.Profiles.ModelProfile

/**
 * Deterministic routing policy (port of src/routing/router.ts): given a task and what is available, decides an
 * execution plan (a typed list of steps). It executes nothing and never judges whether an answer is correct. Rule
 * based, not LLM driven: the same input always gives the same plan.
 */
object Router {
    /**
     * A greeting reply has nothing to fill a large budget with ("whats up?" ran to the full 512 tokens and rambled).
     * A cap, not a floor: it only ever lowers the user's Max Output Tokens.
     */
    const val GREETING_MAX_TOKENS = 128

    /** Token cap in low-power mode. */
    const val LOW_POWER_MAX_TOKENS = 256

    /** The verify step's token budget. */
    const val VERIFY_MAX_TOKENS = 200

    data class InferenceBudget(
        val maxTokens: Int,
        /** Soft ceiling passed through to each generate/verify step's timeoutMs; advisory, not enforced here. */
        val maxTotalLatencyMs: Long? = null,
        val allowVerification: Boolean,
        val allowRetrieval: Boolean,
    )

    data class DeviceState(
        val freeRamBytes: Long? = null,
        /** Not wired to a battery API yet. */
        val batteryLevel: Double? = null,
        val lowPowerMode: Boolean? = null,
    )

    enum class FallbackPolicy(val value: String) { SKIP("skip"), USE_DEFAULT("use-default"), FAIL("fail") }

    /**
     * [modelSwitches]: how many times the plan swaps the resident generation model. A real cost: only one generation
     * context fits at a time, so each swap is an unload + reload with a RAM pre-flight check.
     */
    data class CostEstimate(val modelSwitches: Int)

    data class RoutingStep(
        val id: String,
        val type: RoutingStepType,
        val modelId: String? = null,
        val required: Boolean,
        val maxTokens: Int? = null,
        val timeoutMs: Long? = null,
    )

    data class RoutingContext(
        val taskType: TaskType,
        val query: String,
        val hasLocalKnowledgeBase: Boolean,
        val retrievalAvailable: Boolean,
        /** Already-resolved profiles (Profiles.buildModelProfiles): the router trusts them. */
        val availableModels: List<ModelProfile>,
        val preset: RoutingPreset,
        val deviceState: DeviceState? = null,
        val budget: InferenceBudget,
    )

    data class RoutingPlan(
        val steps: List<RoutingStep>,
        val selectedModelIds: List<String>,
        val estimatedCost: CostEstimate,
        val fallbackPolicy: FallbackPolicy,
        /** Short machine-readable codes explaining every decision. */
        val reasonCodes: List<String>,
    )

    private fun findProfile(models: List<ModelProfile>, role: ModelRole): ModelProfile? =
        models.firstOrNull { it.role == role && it.enabled }

    /**
     * The generation role a task/preset prefers before looking at what is available. Research and compare always want
     * the strongest model whatever the preset: a Simple-preset user asking a hard question shouldn't get a worse answer.
     */
    private fun preferredRole(taskType: TaskType, preset: RoutingPreset): ModelRole {
        if (taskType == TaskType.GREETING || taskType == TaskType.CONVERSATION) return ModelRole.FAST
        if (taskType == TaskType.RESEARCH || taskType == TaskType.COMPARE || preset == RoutingPreset.RESEARCH) return ModelRole.REASONING
        if (preset == RoutingPreset.SIMPLE) return ModelRole.GENERAL
        return ModelRole.FAST
    }

    fun planRoute(context: RoutingContext): RoutingPlan {
        val reasonCodes = ArrayList<String>()
        val steps = ArrayList<RoutingStep>()
        val selectedModelIds = ArrayList<String>()
        var stepIndex = 0
        fun nextId(type: RoutingStepType) = "${type.value}-${stepIndex++}"

        val constrained = context.deviceState?.lowPowerMode == true
        var effectiveMaxTokens = context.budget.maxTokens
        if (constrained) {
            effectiveMaxTokens = minOf(effectiveMaxTokens, LOW_POWER_MAX_TOKENS)
            reasonCodes += "budget:low-power-mode-caps-tokens-and-role"
        }
        if (context.taskType == TaskType.GREETING) {
            // Caps, never raises: a lower user Max Output Tokens stays.
            effectiveMaxTokens = minOf(effectiveMaxTokens, GREETING_MAX_TOKENS)
            reasonCodes += "budget:greeting-caps-tokens"
        }

        // 1. Retrieval, skipped where local documents aren't the relevant input (Classify.isRetrievalIrrelevant).
        val retrievalIrrelevant = Classify.isRetrievalIrrelevant(context.taskType)
        val wantsRetrieval = context.budget.allowRetrieval && context.retrievalAvailable && context.hasLocalKnowledgeBase && !retrievalIrrelevant
        if (wantsRetrieval) {
            steps += RoutingStep(id = nextId(RoutingStepType.RETRIEVE), type = RoutingStepType.RETRIEVE, required = false)
            reasonCodes += "retrieve:relevant-to-task"
        } else {
            reasonCodes += if (retrievalIrrelevant) "retrieve:skipped-task-not-knowledge-based" else "retrieve:skipped-unavailable-or-disabled"
        }

        // 2. Generation, the one required step. The preferred role degrades to whatever is enabled rather than failing:
        // a user with one suitable model still has a functional app.
        val wantRole = if (constrained) ModelRole.FAST else preferredRole(context.taskType, context.preset)
        var genProfile = findProfile(context.availableModels, wantRole)
        if (genProfile == null) {
            genProfile = findProfile(context.availableModels, ModelRole.GENERAL)
                ?: findProfile(context.availableModels, ModelRole.REASONING)
                ?: findProfile(context.availableModels, ModelRole.FAST)
                ?: context.availableModels.firstOrNull { it.enabled }
            if (genProfile != null) reasonCodes += "generate:role-${wantRole.value}-unavailable-fell-back-to-${genProfile.role.value}"
        } else {
            reasonCodes += "generate:role-${wantRole.value}-resolved-to-${genProfile.modelId}"
        }

        if (genProfile != null) {
            steps += RoutingStep(
                id = nextId(RoutingStepType.GENERATE),
                type = RoutingStepType.GENERATE,
                modelId = genProfile.modelId,
                required = true,
                maxTokens = effectiveMaxTokens,
                timeoutMs = context.budget.maxTotalLatencyMs,
            )
            selectedModelIds += genProfile.modelId
        } else {
            reasonCodes += "generate:no-model-available"
        }

        // 3. Verification, only when plausibly worth its cost: research/compare under the research preset, with
        // retrieved evidence AND a verifier that is a different model (a model grading itself isn't verification).
        val wantsVerification = context.budget.allowVerification &&
            !constrained &&
            context.preset == RoutingPreset.RESEARCH &&
            (context.taskType == TaskType.RESEARCH || context.taskType == TaskType.COMPARE) &&
            wantsRetrieval &&
            genProfile != null
        if (wantsVerification) {
            val verifierProfile = findProfile(context.availableModels, ModelRole.VERIFIER)
            if (verifierProfile != null && verifierProfile.modelId != genProfile!!.modelId) {
                steps += RoutingStep(
                    id = nextId(RoutingStepType.VERIFY),
                    type = RoutingStepType.VERIFY,
                    modelId = verifierProfile.modelId,
                    required = false,
                    maxTokens = VERIFY_MAX_TOKENS,
                    timeoutMs = context.budget.maxTotalLatencyMs,
                )
                if (verifierProfile.modelId !in selectedModelIds) selectedModelIds += verifierProfile.modelId
                reasonCodes += "verify:enabled"
            } else {
                reasonCodes += "verify:skipped-no-distinct-verifier-model"
            }
        } else {
            reasonCodes += "verify:not-applicable"
        }

        return RoutingPlan(
            steps = steps,
            selectedModelIds = selectedModelIds,
            estimatedCost = CostEstimate(modelSwitches = maxOf(0, selectedModelIds.size - 1)),
            fallbackPolicy = FallbackPolicy.USE_DEFAULT,
            reasonCodes = reasonCodes,
        )
    }
}
