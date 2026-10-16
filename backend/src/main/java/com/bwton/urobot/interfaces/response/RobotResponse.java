package com.bwton.urobot.interfaces.response;

import io.github.bwtrobot.opensdk.services.robot.model.RobotItem;

import java.util.Map;

public class RobotResponse extends BaseResponse {
    private String id;
    private String modelCode;
    private String name;
    private Map<String, Object> map;
    private Map<String, Object> config;
    private Map<String, Object> attributes;
    private String terminalSn;
    private String status;
    private Integer statusValue;
    private String terminalType;
    private Integer terminalTypeValue;
    private Integer terminalPower;
    private String updateTime;
    private Map<String, Object> updateUser;
    private Integer deviceType;
    private String deviceTypeDesc;

    public static RobotResponse from(RobotItem item) {
        RobotResponse response = new RobotResponse();
        response.setId(item.id());
        response.setModelCode(item.modelCode());
        response.setName(item.name());
        response.setMap(item.map());
        response.setConfig(item.config());
        response.setAttributes(item.attributes());
        response.setTerminalSn(item.terminalSn());
        response.setStatus(item.status());
        response.setStatusValue(item.statusValue());
        response.setTerminalType(item.terminalType());
        response.setTerminalTypeValue(item.terminalTypeValue());
        response.setTerminalPower(item.terminalPower());
        response.setUpdateTime(item.updateTime());
        response.setUpdateUser(item.updateUser());
        response.setDeviceType(item.deviceType());
        response.setDeviceTypeDesc(item.deviceTypeDesc());
        return response;
    }

    public String getModelCode() { return modelCode; }

    public void setModelCode(String modelCode) { this.modelCode = modelCode; }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public Map<String, Object> getMap() {
        return map;
    }

    public void setMap(Map<String, Object> map) {
        this.map = map;
    }

    public Map<String, Object> getConfig() {
        return config;
    }

    public void setConfig(Map<String, Object> config) {
        this.config = config;
    }

    public Map<String, Object> getAttributes() {
        return attributes;
    }

    public void setAttributes(Map<String, Object> attributes) {
        this.attributes = attributes;
    }

    public String getTerminalSn() {
        return terminalSn;
    }

    public void setTerminalSn(String terminalSn) {
        this.terminalSn = terminalSn;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }

    public Integer getStatusValue() {
        return statusValue;
    }

    public void setStatusValue(Integer statusValue) {
        this.statusValue = statusValue;
    }

    public String getTerminalType() {
        return terminalType;
    }

    public void setTerminalType(String terminalType) {
        this.terminalType = terminalType;
    }

    public Integer getTerminalTypeValue() {
        return terminalTypeValue;
    }

    public void setTerminalTypeValue(Integer terminalTypeValue) {
        this.terminalTypeValue = terminalTypeValue;
    }

    public Integer getTerminalPower() {
        return terminalPower;
    }

    public void setTerminalPower(Integer terminalPower) {
        this.terminalPower = terminalPower;
    }

    public String getUpdateTime() {
        return updateTime;
    }

    public void setUpdateTime(String updateTime) {
        this.updateTime = updateTime;
    }

    public Map<String, Object> getUpdateUser() {
        return updateUser;
    }

    public void setUpdateUser(Map<String, Object> updateUser) {
        this.updateUser = updateUser;
    }

    public Integer getDeviceType() {
        return deviceType;
    }

    public void setDeviceType(Integer deviceType) {
        this.deviceType = deviceType;
    }

    public String getDeviceTypeDesc() {
        return deviceTypeDesc;
    }

    public void setDeviceTypeDesc(String deviceTypeDesc) {
        this.deviceTypeDesc = deviceTypeDesc;
    }
}
