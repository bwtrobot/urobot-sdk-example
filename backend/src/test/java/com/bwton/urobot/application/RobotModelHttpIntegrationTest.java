package com.bwton.urobot.application;

import com.bwton.urobot.interfaces.api.*;
import com.bwton.urobot.infrastructure.config.URobotConfiguration;
import com.fasterxml.jackson.databind.*;
import com.sun.net.httpserver.HttpServer;
import io.github.bwtrobot.opensdk.core.auth.AccessKeyCredentials;
import io.github.bwtrobot.opensdk.services.URobotClient;
import org.junit.jupiter.api.*;
import org.springframework.http.codec.json.*;
import org.springframework.http.converter.json.Jackson2ObjectMapperBuilder;
import org.springframework.test.web.reactive.server.WebTestClient;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.CopyOnWriteArrayList;
import static org.junit.jupiter.api.Assertions.*;

/** 通过真实 SDK 和随机端口 HTTP 上游验证 BFF 协议。 */
class RobotModelHttpIntegrationTest {
    HttpServer server;
    URobotClient sdk;
    WebTestClient http;
    final List<URI> requests = new CopyOnWriteArrayList<>();
    final ObjectMapper json = new ObjectMapper();
    volatile String response;
    volatile int status;

    @BeforeEach void setup() throws Exception {
        status = 200;
        response = success("{}");
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            String body;
            int code;
            if (exchange.getRequestURI().getPath().equals("/api/open/v1/token")) {
                body = success("{\"accessToken\":\"token\",\"refreshToken\":\"refresh\"}");
                code = 200;
            } else {
                requests.add(exchange.getRequestURI());
                body = response;
                code = status;
            }
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(code, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        server.start();
        sdk = URobotClient.builder().endpoint("http://127.0.0.1:" + server.getAddress().getPort())
                .credentialsProvider(() -> AccessKeyCredentials.of("test", "secret")).build();
        Jackson2ObjectMapperBuilder builder = new Jackson2ObjectMapperBuilder();
        new URobotConfiguration().jacksonCustomizer().customize(builder);
        ObjectMapper mapper = builder.build();
        http = WebTestClient.bindToController(new RobotHandler(new RobotService(sdk), null))
                .controllerAdvice(new GlobalExceptionHandler())
                .httpMessageCodecs(c -> {
                    c.defaultCodecs().jackson2JsonEncoder(new Jackson2JsonEncoder(mapper));
                    c.defaultCodecs().jackson2JsonDecoder(new Jackson2JsonDecoder(mapper));
                }).build();
    }
    @AfterEach void cleanup() {
        try {
            if (sdk != null) {
                sdk.close();
            }
        } finally {
            if (server != null) {
                server.stop(0);
            }
        }
    }
    static String success(String value) { return "{\"success\":true,\"errcode\":\"0000\",\"result\":" + value + "}"; }
    JsonNode get(String code) throws Exception {
        byte[] body = http.get().uri(b -> b.path("/robot/model").queryParam("modelCode", "{code}").build(code))
                .exchange().expectStatus().isOk().expectBody().returnResult().getResponseBody();
        return json.readTree(body).get("result");
    }
    @Test void mapsAllFieldsAndEncodesDynamicCodeWithoutTrimming() throws Exception {
        String code = " 定制 +/机型?&=% ";
        Map<String,Object> model = new LinkedHashMap<>();
        for (String name : Arrays.asList("id", "nameZh", "nameEn", "urdfFileKey", "urdfMainPath", "cardPosterFileKey", "ratioPosterFileKey", "autoChargeMode", "enabledTime", "description", "createTime", "updateTime")) model.put(name, name + "值");
        model.put("deviceType", 7); model.put("status", 1); model.put("modelCode", code);
        model.put("terminal_type", null); model.put("terminal_type_value", null); model.put("virtualActionSupported", true);
        Map<String,Object> file = new LinkedHashMap<>();
        for (String name : Arrays.asList("fileId", "fileName", "contentType", "url", "disposition")) file.put(name, name + "值");
        model.put("urdf", file); model.put("cardPoster", file); model.put("ratioPoster", file);
        response = success(json.writeValueAsString(model));
        assertEquals(json.valueToTree(model), get(code));
        assertEquals(1, requests.size());
        assertEquals("/api/open/v1/robot-model", requests.get(0).getPath());
        assertEquals("modelCode=" + code, URLDecoder.decode(requests.get(0).getRawQuery(), "UTF-8"));
    }
    @Test void preservesNullFilesAndScalarValues() throws Exception {
        response = success("{\"modelCode\":\"new\",\"urdf\":null,\"cardPoster\":null,\"ratioPoster\":null}");
        JsonNode value = get("new");
        assertEquals(21, value.size());
        for (String name : Arrays.asList("urdf", "cardPoster", "ratioPoster", "terminal_type", "terminal_type_value", "virtualActionSupported")) assertTrue(value.has(name) && value.get(name).isNull(), name);
    }
    @Test void rejectsMissingCodeWithoutUpstream() {
        http.get().uri("/robot/model").exchange().expectStatus().isBadRequest()
                .expectBody().jsonPath("$.success").isEqualTo(false).jsonPath("$.errcode").isEqualTo("BAD_REQUEST");
        assertTrue(requests.isEmpty());
    }
    @Test void rejectsEmptyAndWhitespaceWithoutUpstream() {
        for (String code : Arrays.asList("", " ", "\t\n")) {
            http.get().uri(b -> b.path("/robot/model").queryParam("modelCode", "{code}").build(code)).exchange()
                    .expectStatus().isBadRequest().expectBody().jsonPath("$.errcode").isEqualTo("BAD_REQUEST");
        }
        assertTrue(requests.isEmpty());
    }
    @Test void wrapsUpstreamBusinessError() {
        response = "{\"success\":false,\"errcode\":\"MODEL_MISSING\",\"errmsg\":\"机型不存在\"}";
        http.get().uri("/robot/model?modelCode=missing").exchange().expectStatus().is5xxServerError()
                .expectBody().jsonPath("$.success").isEqualTo(false).jsonPath("$.errcode").isEqualTo("INTERNAL_ERROR");
        assertFalse(requests.isEmpty());
    }
    @Test void wrapsUpstreamHttpFailure() {
        status = 400; response = "upstream failure";
        http.get().uri("/robot/model?modelCode=failed").exchange().expectStatus().is5xxServerError()
                .expectBody().jsonPath("$.success").isEqualTo(false).jsonPath("$.errcode").isEqualTo("INTERNAL_ERROR");
        assertFalse(requests.isEmpty());
    }
    @Test void mapsListDynamicCodeAndKeepsExistingNames() {
        response = success("{\"rows\":[{\"id\":\"r1\",\"model_code\":\"custom-v42\",\"terminal_sn\":\"sn\",\"terminal_type\":null,\"terminal_type_value\":null,\"device_type\":7}],\"total_count\":1,\"page_no\":1,\"page_size\":10}");
        http.get().uri("/robot/page").exchange().expectStatus().isOk().expectBody()
                .jsonPath("$.result.rows[0].model_code").isEqualTo("custom-v42")
                .jsonPath("$.result.rows[0].terminal_sn").isEqualTo("sn")
                .jsonPath("$.result.rows[0].device_type").isEqualTo(7);
        assertEquals("/api/open/v1/robot/page", requests.get(0).getPath());
    }
}
