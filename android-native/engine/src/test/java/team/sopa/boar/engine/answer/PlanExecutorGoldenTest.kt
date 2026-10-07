package team.sopa.boar.engine.answer

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Test
import team.sopa.boar.engine.GenerationMetrics
import team.sopa.boar.engine.rag.Chunk
import team.sopa.boar.engine.routing.Classify
import team.sopa.boar.engine.routing.Router
import team.sopa.boar.engine.routing.RoutingStepType
import java.io.File

/**
 * The adaptive-routing executor must load, prompt and report as src/routing/executor.ts does
 * (scripts/export-native-golden-executor.mjs: real plans, recording stand-ins for the engine and retrieval).
 */
class PlanExecutorGoldenTest {
    private val g = Json.parseToJsonElement(File("src/test/resources/golden/executor.json").readText()).jsonObject
    private val JsonElement.str get() = if (this is JsonNull) null else jsonPrimitive.content

    private fun plan(o: JsonObject) = Router.RoutingPlan(
        steps = o["steps"]!!.jsonArray.map { it.jsonObject }.map { s ->
            Router.RoutingStep(
                s["id"]!!.str!!, RoutingStepType.of(s["type"]!!.str!!), s["modelId"]?.str, s["required"]!!.jsonPrimitive.boolean,
                s["maxTokens"]?.jsonPrimitive?.intOrNull, s["timeoutMs"]?.let { if (it is JsonNull) null else it.jsonPrimitive.long },
            )
        },
        selectedModelIds = o["selectedModelIds"]!!.jsonArray.map { it.str!! },
        estimatedCost = Router.CostEstimate(o["estimatedCost"]!!.jsonObject["modelSwitches"]!!.jsonPrimitive.int),
        fallbackPolicy = Router.FallbackPolicy.entries.first { it.value == o["fallbackPolicy"]!!.str },
        reasonCodes = o["reasonCodes"]!!.jsonArray.map { it.str!! },
    )

    private fun chunk(o: JsonObject) = Chunk(o["chunkId"]!!.str!!, o["docId"]!!.str!!, o["title"]!!.str!!, o["body"]!!.str!!, source = o["source"]?.str, score = o["score"]!!.jsonPrimitive.double)

    @Test fun `loads, prompts and results on every recorded execution`() = runBlocking {
        for ((ci, c) in g["cases"]!!.jsonArray.map { it.jsonObject }.withIndex()) {
            val where = "case $ci ${c["input"]!!.jsonObject["query"]!!.str}"
            val calls = c["calls"]!!.jsonArray.map { it.jsonObject }
            val retrievals = c["retrievals"]!!.jsonArray.map { it.jsonObject }
            val template = c["template"]!!.jsonPrimitive.boolean
            val missing = c["missing"]?.str
            var resident = c["resident"]!!.str
            val loads = ArrayList<String>()
            var n = 0
            var k = 0
            val engine = object : StepEngine {
                override val hasChatTemplate = template
                override suspend fun generate(req: GenRequest, onToken: ((String) -> Unit)?): Pair<String, GenerationMetrics?> {
                    val want = calls[n++]
                    val msgs = want["messages"]!!.let { if (it is JsonNull) null else it.jsonArray.map { m -> m.jsonObject["role"]!!.str + ": " + m.jsonObject["content"]!!.str } }
                    assertEquals("$where call $n messages", msgs, req.messages?.map { "${it.role}: ${it.content}" })
                    assertEquals("$where call $n prompt", want["prompt"]!!.str, req.prompt)
                    assertEquals("$where call $n nPredict", want["nPredict"]!!.jsonPrimitive.int, req.nPredict)
                    assertEquals("$where call $n temperature", want["temperature"]!!.jsonPrimitive.double, req.temperature.toDouble(), 1e-6)
                    // The recorder sits in front of LlamaEngine, which adds DEFAULT_STOP_SEQUENCES to a plain prompt itself.
                    val stops = want["stop"]!!.let { if (it is JsonNull) (if (req.prompt != null) AnswerPipeline.DEFAULT_STOP_SEQUENCES else emptyList()) else it.jsonArray.map { s -> s.str!! } }
                    assertEquals("$where call $n stops", stops, req.stops)
                    val reply = want["reply"]!!.str!!
                    onToken?.invoke(reply)
                    return reply to null
                }
            }
            val host = object : ModelHost {
                override fun residentFilename() = resident
                override fun filenameOf(modelId: String) = if (modelId == missing) null else "models/$modelId.gguf"
                override suspend fun load(modelId: String): StepEngine {
                    val f = "models/$modelId.gguf"
                    // The TS engine loads only when the model isn't resident; a resident one is just used.
                    if (resident != f) { loads += f; resident = f }
                    return engine
                }
            }
            val retrieve = { q: String, topK: Int ->
                val want = retrievals[k++]
                assertEquals("$where retrieval", want["query"]!!.str, q)
                assertEquals(want["k"]!!.jsonPrimitive.int, topK)
                want["chunks"]!!.jsonArray.map { chunk(it.jsonObject) }
            }
            val input = c["input"]!!.jsonObject
            val r = PlanExecutor(host, retrieve, { Classify.classifyTask(it).value }).execute(
                plan(c["plan"]!!.jsonObject),
                PipelineInput(input["query"]!!.str!!, input["systemPrompt"]!!.str, input["styleReminder"]!!.str),
            )
            val want = c["result"]!!.jsonObject
            assertEquals("$where calls", calls.size, n)
            assertEquals("$where loads", c["loads"]!!.jsonArray.map { it.str }, loads)
            assertEquals("$where answer", want["answer"]!!.str, r.answer)
            assertEquals("$where citations", want["citations"]!!.jsonArray.map { it.str }, r.citations.map { "${it.chunkId} | ${it.body}" })
            val ver = want["verification"]!!.jsonObject
            assertEquals("$where verification", Verification(ver["status"]!!.str!!, ver["note"]?.str), r.verification)
            assertEquals("$where warnings", want["warnings"]!!.jsonArray.map { it.str }, r.warnings)
            assertEquals("$where steps", want["stepsExecuted"]!!.jsonPrimitive.int, r.stepsExecuted)
            assertEquals("$where switches", want["modelSwitches"]!!.jsonPrimitive.int, r.modelSwitches)
            assertEquals("$where cross", want["crossMessageModelSwitch"]!!.jsonPrimitive.boolean, r.crossMessageModelSwitch)
            assertEquals("$where residency", want["modelResidency"]!!.str, r.modelResidency)
            assertEquals("$where format", want["promptFormat"]!!.str, r.promptFormat)
            assertEquals("$where ctx", want["contextTokensBefore"]!!.jsonPrimitive.intOrNull, r.contextTokensBefore)
            assertEquals("$where ctx after", want["contextTokensAfter"]!!.jsonPrimitive.intOrNull, r.contextTokensAfter)
        }
    }

    @Test fun `verdict parsing`() {
        for (p in g["parse"]!!.jsonArray.map { it.jsonObject }) {
            val o = p["out"]!!.jsonObject
            assertEquals(p["t"]!!.str, Verification(o["status"]!!.str!!, o["note"]?.str), Verify.parse(p["t"]!!.str!!))
        }
    }
}
