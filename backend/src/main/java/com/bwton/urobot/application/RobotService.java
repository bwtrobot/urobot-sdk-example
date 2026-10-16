package com.bwton.urobot.application;

import com.bwton.urobot.infrastructure.lang.Page;
import com.bwton.urobot.infrastructure.lang.PageQuery;
import com.bwton.urobot.interfaces.request.ControlNarrationBody;
import com.bwton.urobot.interfaces.request.SendCommandBody;
import com.bwton.urobot.interfaces.response.RobotResponse;
import io.github.bwtrobot.opensdk.services.URobotClient;
import io.github.bwtrobot.opensdk.services.robot.model.*;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import java.lang.reflect.Method;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.Arrays;
import java.util.Comparator;
import java.util.stream.Collectors;

@Service
public class RobotService {
    private final URobotClient uRobotClient;

    public RobotService(URobotClient uRobotClient) {
        this.uRobotClient = uRobotClient;
    }

    public Mono<Map<String, Object>> getRobotModel(String modelCode) {
        return Mono.fromSupplier(() -> {
            // 编码只校验不改写，保留动态机型编码中的空格与特殊字符。
            requireText(modelCode, "modelCode");
            GetRobotModelRequest request = GetRobotModelRequest.builder().modelCode(modelCode).build();
            RobotModel model = uRobotClient.robot().getRobotModel(request).model();
            // 使用显式 Map 保持详情契约，不受全局蛇形命名策略影响。
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("id", model.id());
            result.put("deviceType", model.deviceType());
            result.put("nameZh", model.nameZh());
            result.put("nameEn", model.nameEn());
            result.put("modelCode", model.modelCode());
            result.put("terminal_type", model.terminalType());
            result.put("terminal_type_value", model.terminalTypeValue());
            result.put("urdfFileKey", model.urdfFileKey());
            result.put("urdfMainPath", model.urdfMainPath());
            result.put("cardPosterFileKey", model.cardPosterFileKey());
            result.put("ratioPosterFileKey", model.ratioPosterFileKey());
            result.put("virtualActionSupported", model.virtualActionSupported());
            result.put("autoChargeMode", model.autoChargeMode());
            result.put("status", model.status());
            result.put("enabledTime", model.enabledTime());
            result.put("description", model.description());
            result.put("createTime", model.createTime());
            result.put("updateTime", model.updateTime());
            result.put("urdf", robotModelFileToMap(model.urdf()));
            result.put("cardPoster", robotModelFileToMap(model.cardPoster()));
            result.put("ratioPoster", robotModelFileToMap(model.ratioPoster()));
            return result;
        }).subscribeOn(Schedulers.boundedElastic());
    }

    private Map<String, Object> robotModelFileToMap(RobotModelFile file) {
        // 上游没有文件引用时保留 null，避免生成看似可用的空文件对象。
        if (file == null) { return null; }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("fileId", file.fileId());
        result.put("fileName", file.fileName());
        result.put("contentType", file.contentType());
        result.put("url", file.url());
        result.put("disposition", file.disposition());
        return result;
    }

    public Mono<Page<RobotResponse>> page(PageQuery query) {
        return Mono.fromSupplier(() -> {
            ListRobotsRequest request = ListRobotsRequest.builder()
                    .pageSize(query.getPageSize())
                    .pageNum(query.getPageNo())
                    .build();
            ListRobotsResponse listRobotsResponse = uRobotClient.robot().listRobots(request);
            return listRobotsResponse;
        }).map(response -> {
            List<RobotItem> list = response.data();
            Page<RobotResponse> page = new Page<>();
            page.setPageNo(response.pageNum());
            page.setPageSize(response.pageSize());
            page.setRows(list.stream()
                    .map(RobotResponse::from)
                    .collect(Collectors.toList()));
            page.setTotalCount(Math.toIntExact(response.total()));
            page.setTotalPage((int) Math.ceil((double) response.total() / response.pageSize()));
            return page;
        }).subscribeOn(Schedulers.boundedElastic());
    }

    public Mono<Map<String, Object>> getRobotRuntime(String robotId) {
        return Mono.fromSupplier(() -> {
            GetRobotRuntimeRequest request = GetRobotRuntimeRequest.builder()
                    .robotId(robotId)
                    .build();
            return uRobotClient.robot().getRobotRuntime(request).runtime();
        }).subscribeOn(Schedulers.boundedElastic());
    }

    public Mono<String> sendCommand(String robotId, SendCommandBody body) {
        return Mono.fromSupplier(() -> {
            Map<String, Object> params = normalizeCommandParams(body.getParams());
            SendCommandRequest.Builder builder = SendCommandRequest.builder()
                    .robotId(robotId)
                    .type(body.getType())
                    .messagesType(normalizeMessagesType(body.getMessagesType()))
                    .params(params);
            if (body.getCallbackUrl() != null && !body.getCallbackUrl().trim().isEmpty()) {
                builder.callbackUrl(body.getCallbackUrl());
            }

            return uRobotClient.robot().sendCommand(builder.build()).taskId();
        }).subscribeOn(Schedulers.boundedElastic());
    }

    private String normalizeMessagesType(String messagesType) {
        if (messagesType == null || messagesType.trim().isEmpty()) {
            return "task_submit";
        }
        return messagesType;
    }

    private Map<String, Object> normalizeCommandParams(Map<String, Object> rawParams) {
        Map<String, Object> params = new LinkedHashMap<>();
        if (rawParams != null) {
            params.putAll(rawParams);
        }

        Object taskId = params.get("task_id");
        if (taskId == null || String.valueOf(taskId).trim().isEmpty()) {
            taskId = params.remove("taskId");
        }
        if (taskId == null || String.valueOf(taskId).trim().isEmpty()) {
            taskId = UUID.randomUUID().toString();
        }
        params.put("task_id", taskId);

        return params;
    }

    public Mono<List<Map<String, Object>>> getTaskResult(String robotId, List<String> taskIds) {
        return Mono.fromSupplier(() -> {
            GetTaskResultRequest request = GetTaskResultRequest.builder()
                    .robotId(robotId)
                    .taskIds(taskIds)
                    .build();
            List<TaskReply> replies = uRobotClient.robot().getTaskResult(request).data();
            return replies.stream().map(this::taskReplyToMap).collect(Collectors.toList());
        }).subscribeOn(Schedulers.boundedElastic());
    }

    public Mono<Map<String, Object>> controlNarration(String robotId, ControlNarrationBody body, String segmentMode) {
        return Mono.fromSupplier(() -> {
            return controlNarrationToMap(uRobotClient.robot().controlNarration(buildControlNarrationRequest(robotId, body, segmentMode)));
        }).subscribeOn(Schedulers.boundedElastic());
    }

    public Mono<List<Map<String, Object>>> getNarrationRuntime(String robotId, String segmentMode) {
        return Mono.fromSupplier(() -> {
            List<NarrationRuntime> runtimes = uRobotClient.robot().getNarrationRuntime(buildGetNarrationRuntimeRequest(robotId, segmentMode)).runtimes();
            if (runtimes == null) {
                return Collections.<Map<String, Object>>emptyList();
            }
            return runtimes.stream().map(this::narrationRuntimeToMap).collect(Collectors.toList());
        }).subscribeOn(Schedulers.boundedElastic());
    }

    // 查询机器人关联的地图列表
    public Mono<List<Map<String, Object>>> listRobotMaps(String robotId) {
        return Mono.fromSupplier(() -> {
            ListRobotMapsRequest request = ListRobotMapsRequest.builder()
                    .robotId(robotId)
                    .build();
            List<RobotMap> maps = uRobotClient.robot().listRobotMaps(request).data();
            if (maps == null) {
                return Collections.<Map<String, Object>>emptyList();
            }
            return maps.stream().map(item -> {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("id", item.id());
                m.put("name", item.name());
                m.put("createTime", item.createTime());
                return m;
            }).collect(Collectors.toList());
        }).subscribeOn(Schedulers.boundedElastic());
    }

    public Mono<String> activateMap(String robotId, String editionId) {
        return Mono.fromSupplier(() -> {
            requireText(editionId, "editionId");
            ActivateMapRequest request = ActivateMapRequest.builder()
                    .robotId(robotId)
                    .editionId(editionId)
                    .build();
            return uRobotClient.robot().activateMap(request).taskId();
        }).subscribeOn(Schedulers.boundedElastic());
    }

    private Map<String, Object> taskReplyToMap(TaskReply reply) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("task_id", reply.taskId());
        map.put("task_status", reply.taskStatus());
        map.put("messages_type", reply.messagesType());
        if (reply.commandRespList() != null) {
            map.put("command_resp_list", reply.commandRespList().stream().map(cmd -> {
                Map<String, Object> cmdMap = new LinkedHashMap<>();
                cmdMap.put("status", cmd.status());
                cmdMap.put("result", cmd.result());
                cmdMap.put("description", cmd.description());
                cmdMap.put("task_command_code", cmd.taskCommandCode());
                cmdMap.put("task_command_id", cmd.taskCommandId());
                return cmdMap;
            }).collect(Collectors.toList()));
        }
        return map;
    }

    private Map<String, Object> controlNarrationToMap(ControlNarrationResponse response) {
        return narrationRuntimeFieldsToMap(response);
    }

    private Map<String, Object> narrationRuntimeToMap(NarrationRuntime runtime) {
        return narrationRuntimeFieldsToMap(runtime);
    }

    private Map<String, Object> narrationRuntimeFieldsToMap(Object source) {
        Map<String, Object> map = new LinkedHashMap<>();
        Arrays.stream(source.getClass().getMethods())
                .filter(method -> method.getDeclaringClass().equals(source.getClass()))
                .filter(method -> method.getParameterCount() == 0)
                .filter(method -> !Void.TYPE.equals(method.getReturnType()))
                .sorted(Comparator.comparing(Method::getName))
                .forEach(method -> putRuntimeAccessorValue(map, source, method));
        return map;
    }

    @SuppressWarnings("unchecked")
    private void putRuntimeAccessorValue(Map<String, Object> map, Object source, Method method) {
        try {
            Object value = method.invoke(source);
            if ("nodes".equals(method.getName())) {
                map.put(method.getName(), narrationNodesToList((List<NarrationNode>) value));
                return;
            }
            if ("segments".equals(method.getName())) {
                map.put(method.getName(), narrationSegmentsToList((List<NarrationSegment>) value));
                return;
            }
            map.put(method.getName(), value);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException("讲解运行时字段转换失败: " + method.getName(), e);
        }
    }

    private void validateControlNarrationBody(ControlNarrationBody body) {
        if (body == null) {
            throw new IllegalArgumentException("讲解控制请求体不能为空");
        }
        requireText(body.getEditionId(), "editionId");
        requireText(body.getProcessId(), "processId");
        requireText(body.getCommand(), "command");
        if ("start".equals(body.getCommand())) {
            requireText(body.getProcessName(), "processName");
        }
        if ("node-pick".equals(body.getCommand())) {
            requireText(body.getNodeId(), "nodeId");
            requireText(body.getNodeName(), "nodeName");
        }
    }

    private void requireText(String value, String fieldName) {
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalArgumentException(fieldName + " 不能为空");
        }
    }

    SegmentMode parseSegmentMode(String segmentMode) {
        if (segmentMode == null || segmentMode.trim().isEmpty()) {
            return null;
        }
        String normalized = segmentMode.trim();
        if ("collapsed".equalsIgnoreCase(normalized)) {
            return SegmentMode.COLLAPSED;
        }
        if ("expanded".equalsIgnoreCase(normalized)) {
            return SegmentMode.EXPANDED;
        }
        throw new IllegalArgumentException("segmentMode 仅支持 collapsed 或 expanded");
    }

    GetNarrationRuntimeRequest buildGetNarrationRuntimeRequest(String robotId, String segmentMode) {
        SegmentMode parsedSegmentMode = parseSegmentMode(segmentMode);
        GetNarrationRuntimeRequest.Builder builder = GetNarrationRuntimeRequest.builder()
                .robotId(robotId);
        if (parsedSegmentMode != null) {
            builder.segmentMode(parsedSegmentMode);
        }
        return builder.build();
    }

    ControlNarrationRequest buildControlNarrationRequest(String robotId, ControlNarrationBody body, String segmentMode) {
        validateControlNarrationBody(body);
        SegmentMode parsedSegmentMode = parseSegmentMode(segmentMode);
        // 将前端选择的流程和节点上下文原样交给 SDK，由 SDK 负责实际讲解控制协议。
        ControlNarrationRequest.Builder builder = ControlNarrationRequest.builder()
                .robotId(robotId)
                .editionId(body.getEditionId())
                .processId(body.getProcessId())
                .processName(body.getProcessName())
                .command(body.getCommand())
                .operationSource(body.getOperationSource())
                .nodeId(body.getNodeId())
                .nodeName(body.getNodeName());
        if (parsedSegmentMode != null) {
            builder.segmentMode(parsedSegmentMode);
        }
        return builder.build();
    }

    private List<Map<String, Object>> narrationNodesToList(List<NarrationNode> nodes) {
        return nodes == null ? Collections.emptyList() : nodes.stream().map(this::narrationNodeToMap).collect(Collectors.toList());
    }

    private List<Map<String, Object>> narrationSegmentsToList(List<NarrationSegment> segments) {
        return segments == null ? Collections.emptyList() : segments.stream().map(this::narrationSegmentToMap).collect(Collectors.toList());
    }

    private Map<String, Object> narrationNodeToMap(NarrationNode node) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("nodeIndex", node.nodeIndex());
        map.put("nodeId", node.nodeId());
        map.put("nodeName", node.nodeName());
        map.put("status", node.status());
        map.put("entranceScriptId", node.entranceScriptId());
        map.put("entranceScriptName", node.entranceScriptName());
        map.put("selfScriptId", node.selfScriptId());
        map.put("selfScriptName", node.selfScriptName());
        map.put("exitScriptId", node.exitScriptId());
        map.put("exitScriptName", node.exitScriptName());
        return map;
    }

    Map<String, Object> narrationSegmentToMap(NarrationSegment segment) {
        Map<String, Object> map = new LinkedHashMap<>();
        // segments 属于手写映射分支，SDK 后续新增字段时需在这里同步跟进。
        map.put("nodeIndex", segment.nodeIndex());
        map.put("nodeId", segment.nodeId());
        map.put("nodeName", segment.nodeName());
        // segmentType 实际取值为小写 entrance / self / transition / exit。
        map.put("segmentType", segment.segmentType());
        map.put("selfIndex", segment.selfIndex());
        map.put("fromNodeId", segment.fromNodeId());
        map.put("toNodeId", segment.toNodeId());
        map.put("taskId", segment.taskId());
        map.put("taskStatus", segment.taskStatus());
        return map;
    }
}
