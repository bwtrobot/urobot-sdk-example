package com.bwton.urobot.interfaces.api;

import com.bwton.urobot.application.RobotService;
import com.bwton.urobot.application.RobotRealtimeService;
import com.bwton.urobot.infrastructure.lang.Page;
import com.bwton.urobot.infrastructure.lang.PageQuery;
import com.bwton.urobot.infrastructure.lang.Result;
import com.bwton.urobot.interfaces.request.ActivateMapBody;
import com.bwton.urobot.interfaces.request.ControlNarrationBody;
import com.bwton.urobot.interfaces.request.SendCommandBody;
import com.bwton.urobot.interfaces.response.RealtimeSnapshot;
import com.bwton.urobot.interfaces.response.RobotResponse;
import org.springframework.http.server.reactive.ServerHttpRequest;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("robot")
public class RobotHandler {
    private final RobotService service;
    private final RobotRealtimeService realtimeService;

    public RobotHandler(RobotService service, RobotRealtimeService realtimeService) {
        this.service = service;
        this.realtimeService = realtimeService;
    }

    @GetMapping("model")
    public Mono<Result<Map<String, Object>>> model(@RequestParam(required = false) String modelCode) {
        return service.getRobotModel(modelCode).map(Result::ok);
    }

    @GetMapping("page")
    public Mono<Result<Page<RobotResponse>>> page(@ModelAttribute PageQuery pageQuery) {
        return service.page(pageQuery).map(Result::ok);
    }

    @GetMapping("runtime/{robotId}")
    public Mono<Result<Map<String, Object>>> runtime(@PathVariable String robotId) {
        return service.getRobotRuntime(robotId).map(Result::ok);
    }

    @PostMapping("command/{robotId}")
    public Mono<Result<String>> command(@PathVariable String robotId,
                                         @RequestBody SendCommandBody body) {
        return service.sendCommand(robotId, body).map(Result::ok);
    }

    // 支持 taskIds[0]=xxx&taskIds[1]=yyy indexed 数组格式
    @GetMapping("task-result/{robotId}")
    public Mono<Result<List<Map<String, Object>>>> taskResult(
            @PathVariable String robotId,
            ServerHttpRequest request) {
        MultiValueMap<String, String> queryParams = request.getQueryParams();
        List<String> taskIds = new ArrayList<>();
        queryParams.forEach((key, values) -> {
            if (key.startsWith("taskIds")) {
                taskIds.addAll(values);
            }
        });
        return service.getTaskResult(robotId, taskIds).map(Result::ok);
    }

    @PostMapping("{robotId}/narration/control")
    public Mono<Result<Map<String, Object>>> controlNarration(
            @PathVariable String robotId,
            @RequestBody ControlNarrationBody body,
            @RequestParam(required = false) String segmentMode) {
        return service.controlNarration(robotId, body, segmentMode).map(Result::ok);
    }

    @GetMapping("{robotId}/narration/runtime")
    public Mono<Result<List<Map<String, Object>>>> narrationRuntime(
            @PathVariable String robotId,
            @RequestParam(required = false) String segmentMode) {
        return service.getNarrationRuntime(robotId, segmentMode).map(Result::ok);
    }

    @GetMapping("{robotId}/maps")
    public Mono<Result<List<Map<String, Object>>>> listRobotMaps(@PathVariable String robotId) {
        return service.listRobotMaps(robotId).map(Result::ok);
    }

    @PostMapping("{robotId}/activate-map")
    public Mono<Result<String>> activateMap(@PathVariable String robotId, @RequestBody ActivateMapBody body) {
        return service.activateMap(robotId, body.getEditionId()).map(Result::ok);
    }

    @GetMapping("realtime/{robotId}/snapshot")
    public Mono<Result<RealtimeSnapshot>> realtimeSnapshot(@PathVariable String robotId) {
        return Mono.just(Result.ok(realtimeService.snapshot(robotId)));
    }
}
