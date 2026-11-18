// hyprscope overlay: consent card, live execution banner, result receipt, and the
// blocking interference prompt.
//
// The overlay is deliberately state-driven: it polls the lease state, the
// interference notice, the executor's progress, and the blocking interference
// prompt with `cat`, and it never keeps its own phase machine beyond the
// optimistic "decision pending" / "prompt resolved" flags. A click hides a card
// immediately; the banner then carries the run from "handing over" through
// per-step progress to a short-lived receipt.
import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland

ShellRoot {
    id: root

    property var lease: ({})
    property var notice: null
    property var progress: null
    property var interference: null
    property string pending: ""            // "", "allow", "deny"
    property string pendingError: ""
    property real pendingAt: 0
    property string resolvedId: ""         // interference prompt id answered locally
    property real nowMs: Date.now()
    property real terminalSeenAt: 0

    property string statePath: Quickshell.env("HYPRSCOPE_STATE") || ""
    property var baseDirectory: root.statePath.lastIndexOf("/") >= 0
        ? root.statePath.substring(0, root.statePath.lastIndexOf("/"))
        : ""
    // startOverlay passes all four; the sibling fallbacks keep a manually
    // launched overlay working against the same lease directory.
    property string noticePath: Quickshell.env("HYPRSCOPE_NOTICE")
        || (root.baseDirectory !== "" ? root.baseDirectory + "/notice.json" : "")
    property string progressPath: Quickshell.env("HYPRSCOPE_PROGRESS")
        || (root.baseDirectory !== "" ? root.baseDirectory + "/progress.json" : "")
    property string interferencePath: Quickshell.env("HYPRSCOPE_INTERFERENCE")
        || (root.baseDirectory !== "" ? root.baseDirectory + "/interference.json" : "")
    property string nodePath: Quickshell.env("HYPRSCOPE_NODE") || "node"
    property string binPath: Quickshell.env("HYPRSCOPE_BIN") || ""

    // How long the outcome stays on screen after control returns.
    property int lingerMs: 2400

    function phase() {
        return root.lease && root.lease.phase ? root.lease.phase : ""
    }

    function isTerminalPhase() {
        const current = root.phase()
        return current === "released" || current === "denied" || current === "expired" || current === "revoked"
    }

    function applyState(text) {
        try {
            const parsed = JSON.parse(text)
            if (parsed && parsed.leaseId) {
                root.lease = parsed
                if (parsed.phase === "granted") root.pending = ""
            }
        } catch (error) {
            // Torn read: the next poll sees the complete record.
        }
    }

    function applyNotice(text) {
        try {
            const parsed = JSON.parse(text)
            root.notice = parsed && parsed.leaseId && parsed.text ? parsed : null
        } catch (error) {
            root.notice = null
        }
    }

    function applyProgress(text) {
        try {
            const parsed = JSON.parse(text)
            root.progress = parsed && parsed.leaseId ? parsed : null
        } catch (error) {
            root.progress = null
        }
    }

    function applyInterference(text) {
        try {
            const parsed = JSON.parse(text)
            // A prompt is only valid once it carries an id the answer can echo;
            // without one the card could never tell the executor which prompt it
            // answered, so treat the record as absent.
            root.interference = parsed && parsed.leaseId && parsed.id ? parsed : null
        } catch (error) {
            root.interference = null
        }
    }

    // Reader prints four records separated by a `---` line. JSON on disk is
    // either compact or pretty-printed, so a bare `---` line cannot occur inside
    // a document; a missing file contributes an empty section and each applier
    // treats that as absent. Order: state, notice, progress, interference.
    function applyPoll(text) {
        const separator = "\n---\n"
        const sections = []
        let rest = text
        for (let index = 0; index < 3; index += 1) {
            const at = rest.indexOf(separator)
            if (at < 0) {
                sections.push(rest)
                rest = ""
            } else {
                sections.push(rest.substring(0, at))
                rest = rest.substring(at + separator.length)
            }
        }
        sections.push(rest)
        root.applyState(sections[0])
        root.applyNotice(sections[1])
        root.applyProgress(sections[2])
        root.applyInterference(sections[3])
    }

    function remainingText(deadline) {
        if (!deadline) return ""
        const target = Date.parse(deadline)
        if (isNaN(target)) return ""
        const seconds = Math.max(0, Math.ceil((target - root.nowMs) / 1000))
        const minutes = Math.floor(seconds / 60)
        return minutes + ":" + ("0" + (seconds % 60)).slice(-2)
    }

    function ttlText() {
        const ttl = Number(root.lease.ttlMs)
        return isNaN(ttl) ? "一段时间" : Math.round(ttl / 1000) + " 秒"
    }

    // One consent card for every request: a plan lease shows the plan's
    // description and steps, an approval-only request shows the facts of an act
    // that changes no desktop state. Old state files (planCard/confirm) stay
    // readable as a fallback so upgrading the overlay never loses an open card.
    function cardData() {
        if (!root.lease) return null
        return root.lease.card || root.lease.planCard || root.lease.confirm || null
    }

    // An approval-only consent asks for a decision, not a handoff of control: it
    // records no TTL, starts no holder and never reaches `granted`.
    function isApproval() {
        if (!root.lease) return false
        if (root.lease.approvalOnly !== undefined) return root.lease.approvalOnly === true
        return !!root.lease.confirm
    }

    function cardLines() {
        const card = root.cardData()
        if (!card || !Array.isArray(card.lines)) return ""
        return card.lines.filter(function(line) { return typeof line === "string" && line.length > 0 }).join("\n")
    }

    function cardTitle() {
        const card = root.cardData()
        return card && card.title ? String(card.title) : "Agent 请求操控桌面"
    }

    function allowLabel() {
        const card = root.cardData()
        return card && card.acceptLabel ? String(card.acceptLabel) : "允许操控"
    }

    function denyLabel() {
        const card = root.cardData()
        return card && card.denyLabel ? String(card.denyLabel) : "拒绝"
    }

    // One-line plan preview: `plan · 5 steps · click, text, screenshot`.
    function planLine() {
        const plan = root.lease ? root.lease.planSummary : null
        if (!plan) return ""
        const steps = Number(plan.steps)
        if (!isFinite(steps) || steps < 0) return ""
        const operations = Array.isArray(plan.ops)
            ? plan.ops.filter(function(op) { return typeof op === "string" && op.length > 0 })
            : []
        const label = steps === 1 ? " step" : " steps"
        return "plan · " + steps + label
            + (operations.length > 0 ? " · " + operations.join(", ") : "")
    }

    function hasProgress() {
        const record = root.progress
        return !!record && String(record.leaseId || "") === String(root.lease.leaseId || "")
    }

    // progress.attempt counts the recoveries this run has spent; 0 is the
    // original plan. An older progress.json without the field degrades to 0 so
    // the receipt stays exactly as it was before recoveries existed.
    function attemptCount(record) {
        if (!record) return 0
        const attempt = Number(record.attempt)
        return isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0
    }

    // phase === "recovering" belongs to the running executor, never to the
    // consent hand-over banner: only a granted lease whose run is still running
    // can be recovering.
    function recovering() {
        return root.phase() === "granted" && root.hasProgress()
            && root.progress.status === "running"
            && root.progress.phase === "recovering"
    }

    function progressLine() {
        if (!root.hasProgress()) return ""
        const record = root.progress
        const total = Number(record.total) || 0
        if (root.recovering()) {
            const step = Number(record.step) || 0
            const attempt = root.attemptCount(record)
            if (total <= 0) return "正在恢复…"
            return "第 " + step + "/" + total + " 步"
                + (attempt > 0 ? "（第 " + attempt + " 次恢复）" : "")
        }
        if (record.status === "running") {
            const step = Number(record.step) || 0
            if (total <= 0) return "正在准备执行…"
            return "执行中 " + step + "/" + total + (record.op ? " · " + record.op : "")
        }
        if (record.status === "completed") {
            const attempt = root.attemptCount(record)
            return "执行完成" + (total > 0 ? " · " + total + " 步" : "")
                + (attempt > 0 ? "（含 " + attempt + " 次恢复）" : "")
        }
        if (record.status === "faulted") return "执行失败" + (record.reason ? " · " + record.reason : "")
        if (record.status === "revoked") return "控制已被收回"
        return ""
    }

    function bannerTitle() {
        const current = root.phase()
        if (root.recovering()) return "恢复中"
        if (current === "granted") return "Agent 正在操控桌面"
        if (root.pending === "allow") return "正在交接控制…"
        if (current === "denied") return "已拒绝本次请求"
        if (current === "expired") return "授权超时，未执行"
        if (current === "revoked") return "控制已被收回"
        if (root.hasProgress() && root.progress.status === "completed") return "执行完成"
        if (root.hasProgress() && root.progress.status === "faulted") return "执行失败"
        return "控制已交还"
    }

    function bannerSubtitle() {
        const current = root.phase()
        if (current === "granted") {
            return "剩余 " + root.remainingText(root.lease.expiresAt) + " · SUPER + ALT + ESC 收回"
        }
        if (root.pending === "allow") return "已提交授权请求，等待租约生效"
        return ""
    }

    function accentColor() {
        const current = root.phase()
        if (root.recovering()) return "#e0a04c"
        if (current === "granted") return "#4b7bec"
        if (current === "denied" || current === "expired") return "#b58b2f"
        if (current === "revoked") return "#e06c6c"
        if (root.hasProgress() && root.progress.status === "completed") return "#3fae6a"
        if (root.hasProgress() && root.progress.status === "faulted") return "#e06c6c"
        return "#6f7684"
    }

    function noticeActive() {
        const current = root.notice
        if (!current || typeof current.text !== "string" || current.text.length === 0) return false
        if (String(current.leaseId || "") !== String(root.lease.leaseId || "")) return false
        const expires = Date.parse(current.expiresAt)
        return !isNaN(expires) && expires > root.nowMs
    }

    function noticeText() {
        return root.noticeActive() ? root.notice.text : ""
    }

    // A blocking prompt is live only for the current lease, only until its own
    // deadline, and only while the host has not answered it locally yet.
    function interferenceActive() {
        const current = root.interference
        if (!current || !current.id) return false
        if (String(current.leaseId || "") !== String(root.lease.leaseId || "")) return false
        if (String(current.id) === root.resolvedId) return false
        const expires = Date.parse(current.expiresAt)
        return !isNaN(expires) && expires > root.nowMs
    }

    // Recovery counter for the card, e.g. "第 1/1 次恢复". Records that predate
    // the counters have no maxResumes, so the card falls back to the predicate
    // kind exactly like before.
    function interferenceAttemptLine() {
        const current = root.interference
        if (!current) return ""
        const maxResumes = Number(current.maxResumes)
        if (!isFinite(maxResumes) || maxResumes < 1) return ""
        let attempt = Number(current.attempt)
        // A prompt is always asking about the next recovery, so 0/missing reads
        // as the first one instead of rendering a misleading "第 0/n 次".
        if (!isFinite(attempt) || attempt < 1) attempt = 1
        return "第 " + Math.floor(attempt) + "/" + Math.floor(maxResumes) + " 次恢复"
    }

    // One short line per broken premise, "kind · detail". Only the first three
    // are drawn; the remainder becomes a "+N 项" note.
    function brokenLines() {
        const current = root.interference
        if (!current || !Array.isArray(current.broken)) return []
        const lines = []
        for (let index = 0; index < current.broken.length; index += 1) {
            const entry = current.broken[index]
            if (!entry || typeof entry !== "object") continue
            const kind = typeof entry.kind === "string" ? entry.kind : ""
            const detail = typeof entry.detail === "string" ? entry.detail : ""
            const line = kind !== "" && detail !== "" ? kind + " · " + detail
                : kind !== "" ? kind : detail
            if (line !== "") lines.push(line)
        }
        return lines
    }

    function brokenLineAt(index) {
        const lines = root.brokenLines()
        // The card draws at most three premises; anything past that is counted.
        return index >= 0 && index < Math.min(lines.length, 3) ? lines[index] : ""
    }

    function brokenExtraText() {
        const extra = root.brokenLines().length - 3
        return extra > 0 ? "+" + extra + " 项" : ""
    }

    // One line explaining what answering "continue" buys, e.g.
    // "继续将恢复前提并追加 8s 执行窗口（本次运行最多恢复 1 次）". Old prompts
    // carry neither budgetMs nor maxResumes, so the line is omitted entirely.
    function interferenceContinueLine() {
        const current = root.interference
        if (!current) return ""
        const budget = Number(current.budgetMs)
        const maxResumes = Number(current.maxResumes)
        let line = "继续将恢复前提"
        if (isFinite(budget) && budget > 0) {
            line += "并追加 " + root.secondsText(budget) + " 执行窗口"
        }
        if (isFinite(maxResumes) && maxResumes > 0) {
            line += "（本次运行最多恢复 " + Math.floor(maxResumes) + " 次）"
        }
        return line === "继续将恢复前提" ? "" : line
    }

    function secondsText(ms) {
        const seconds = Number(ms) / 1000
        if (!isFinite(seconds) || seconds <= 0) return ""
        const rounded = Math.round(seconds * 10) / 10
        return rounded + "s"
    }

    function interferenceStepLine() {
        const current = root.interference
        if (!current) return ""
        const step = Number(current.step)
        const total = Number(current.total)
        const position = (isFinite(step) ? step : "?") + "/" + (isFinite(total) ? total : "?")
        const recovery = root.interferenceAttemptLine()
        return "第 " + position + " 步 · " + (recovery !== "" ? recovery : (current.kind || "unknown"))
    }

    function interferenceCountdown() {
        const current = root.interference
        if (!current) return ""
        const expires = Date.parse(current.expiresAt)
        if (isNaN(expires)) return ""
        // At zero the card hides by itself; the executor aborts at the same deadline.
        return Math.max(0, Math.ceil((expires - root.nowMs) / 1000)) + " 秒后自动终止"
    }

    function resolveInterference(decision) {
        const current = root.interference
        if (interferer.running || !current || !current.id) return
        const id = String(current.id)
        if (root.resolvedId === id) return
        // Optimistic: hide the card on the click itself. This only controls how
        // long the card stays up; the executor reads the decision file. A failed
        // command is logged and not retried — the executor's deadline is the
        // safety net, exactly like a prompt the host never answers.
        root.resolvedId = id
        if (root.binPath === "") {
            console.error("hyprscope: cannot record interference decision without HYPRSCOPE_BIN")
            return
        }
        interferer.command = [root.nodePath, root.binPath, "control", "__interference", decision,
            "--id", id, "--source", "overlay", "--json"]
        interferer.running = true
    }

    function cardVisible() {
        return root.phase() === "consent" && root.pending === ""
    }

    function bannerVisible() {
        // An approval has no hand-over to announce: the card is the whole
        // interaction, so nothing stays on screen after the answer.
        if (root.isApproval()) return false
        if (root.phase() === "granted") return true
        if (root.phase() === "consent" && root.pending === "allow") return true
        return root.isTerminalPhase() && root.terminalSeenAt > 0
    }

    function lingerForPhase() {
        if (root.isApproval()) return 700
        if (root.phase() === "denied" || root.phase() === "expired") return 900
        return root.lingerMs
    }

    // The banner's stop button must go through `panic` (released by the lease
    // holder); `__control` only exists while the consent card is still open.
    function releaseNow() {
        if (releaser.running) return
        root.pendingError = ""
        releaser.command = [root.nodePath, root.binPath, "panic", "--json", "--source", "overlay-button"]
        releaser.running = true
    }

    function decide(action) {
        if (control.running || root.pending !== "") return
        if (root.binPath === "") {
            root.pendingError = "内部错误：缺少 hyprscope 入口路径"
            return
        }
        // Optimistic: hide the card on the click itself, not when the requester
        // notices the decision. The banner covers the gap.
        root.pending = action
        root.pendingAt = Date.now()
        root.pendingError = ""
        control.command = [root.nodePath, root.binPath, "control", "__control", action, "--source", "overlay", "--json"]
        control.running = true
    }

    Process {
        id: reader
        // One child reads the four records; a missing file becomes an empty
        // section instead of an error, and paths travel as positional args.
        command: ["sh", "-c",
            "printf '%s\\n---\\n%s\\n---\\n%s\\n---\\n%s\\n' \"$(cat \"$1\" 2>/dev/null)\" \"$(cat \"$2\" 2>/dev/null)\" \"$(cat \"$3\" 2>/dev/null)\" \"$(cat \"$4\" 2>/dev/null)\"",
            "hyprscope-reader", root.statePath, root.noticePath, root.progressPath, root.interferencePath]
        stdout: StdioCollector {
            onStreamFinished: root.applyPoll(this.text)
        }
    }

    Timer {
        interval: 250
        repeat: true
        running: true
        onTriggered: {
            root.nowMs = Date.now()
            if (root.isTerminalPhase()) {
                if (root.terminalSeenAt === 0) root.terminalSeenAt = root.nowMs
                if (root.nowMs - root.terminalSeenAt > root.lingerForPhase()) Qt.quit()
            }
            if (root.phase() === "consent" && root.pending === "allow"
                && root.nowMs - root.pendingAt > 5000) {
                root.pending = ""
                root.pendingError = "授权请求没有响应，请重试"
            }
            if (!reader.running) reader.running = true
        }
    }

    Process {
        id: releaser
        running: false
        onExited: function(exitCode, exitStatus) {
            if (exitCode !== 0) console.log("hyprscope: panic command failed with exit " + exitCode)
        }
    }

    Process {
        id: control
        running: false
        onExited: function(exitCode, exitStatus) {
            if (exitCode !== 0 && root.pending !== "") {
                root.pending = ""
                root.pendingError = "授权命令失败（exit " + exitCode + "）"
            }
        }
    }

    Process {
        id: interferer
        running: false
        onExited: function(exitCode, exitStatus) {
            // No retry: the prompt is already resolved locally and the executor's
            // own deadline decides what happens next. Log so overlay.log tells the
            // story instead of the button silently doing nothing.
            if (exitCode !== 0) {
                console.error("hyprscope: interference decision command failed with exit " + exitCode)
            }
        }
    }

    PanelWindow {
        id: consentWindow
        visible: root.cardVisible()
        anchors {
            top: true
            left: true
            right: true
            bottom: true
        }
        exclusionMode: ExclusionMode.Ignore
        color: "#80000000"
        WlrLayershell.layer: WlrLayer.Overlay
        WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
        WlrLayershell.namespace: "hyprscope-consent"

        Rectangle {
            id: card
            width: 520
            height: form.implicitHeight + 56
            anchors.centerIn: parent
            radius: 16
            color: "#14161b"
            border.width: 1
            border.color: "#2c3038"

            Column {
                id: form
                x: 28
                y: 28
                width: parent.width - 56
                spacing: 14

                Text {
                    text: root.cardTitle()
                    color: "#f2f4f8"
                    font.pixelSize: 20
                    font.bold: true
                }

                Text {
                    width: parent.width
                    text: root.lease.reason || "(未说明原因)"
                    color: "#c7ccd6"
                    font.pixelSize: 14
                    wrapMode: Text.WordWrap
                }

                Text {
                    width: parent.width
                    visible: root.cardLines() !== ""
                    text: root.cardLines()
                    color: "#aab3c2"
                    font.pixelSize: 13
                    lineHeight: 1.35
                    wrapMode: Text.WordWrap
                }

                Text {
                    width: parent.width
                    visible: root.cardLines() === "" && root.planLine() !== ""
                    text: root.planLine()
                    color: "#aab3c2"
                    font.pixelSize: 13
                    wrapMode: Text.WordWrap
                }

                Text {
                    width: parent.width
                    visible: !root.isApproval()
                    text: "同意后，agent 最多操控 " + root.ttlText() + "。期间可以随时按 SUPER + ALT + ESC 收回控制。"
                    color: "#8b93a3"
                    font.pixelSize: 13
                    wrapMode: Text.WordWrap
                }

                Text {
                    width: parent.width
                    visible: root.pendingError !== ""
                    text: root.pendingError
                    color: "#e0a04c"
                    font.pixelSize: 13
                    wrapMode: Text.WordWrap
                }

                Row {
                    spacing: 12
                    topPadding: 6

                    Rectangle {
                        width: 132
                        height: 42
                        radius: 9
                        color: denyArea.pressed ? "#2a2d35" : "#20232a"
                        border.width: 1
                        border.color: "#343945"
                        Text {
                            anchors.centerIn: parent
                            text: root.denyLabel()
                            color: "#d6dae4"
                            font.pixelSize: 14
                        }
                        MouseArea {
                            id: denyArea
                            anchors.fill: parent
                            cursorShape: Qt.PointingHandCursor
                            onClicked: root.decide("deny")
                        }
                    }

                    Rectangle {
                        width: 132
                        height: 42
                        radius: 9
                        color: allowArea.pressed ? "#3d6fe0" : "#4b7bec"
                        Text {
                            anchors.centerIn: parent
                            text: root.allowLabel()
                            color: "#ffffff"
                            font.pixelSize: 14
                            font.bold: true
                        }
                        MouseArea {
                            id: allowArea
                            anchors.fill: parent
                            cursorShape: Qt.PointingHandCursor
                            onClicked: root.decide("allow")
                        }
                    }
                }

                Text {
                    width: parent.width
                    text: "还剩 " + root.remainingText(root.lease.consentDeadline) + " 自动拒绝"
                    color: "#6f7684"
                    font.pixelSize: 12
                }
            }

            Item {
                // The card owns exclusive keyboard focus while it is visible, so
                // Escape denies and Return/Enter allows without a focusable button.
                anchors.fill: parent
                focus: true
                Keys.onEscapePressed: root.decide("deny")
                Keys.onReturnPressed: root.decide("allow")
                Keys.onEnterPressed: root.decide("allow")
            }
        }
    }

    PanelWindow {
        id: bannerWindow
        visible: root.bannerVisible()
        anchors {
            top: true
            left: true
            right: true
        }
        implicitHeight: bannerBody.height
        exclusionMode: ExclusionMode.Ignore
        color: "transparent"
        WlrLayershell.layer: WlrLayer.Overlay
        WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
        WlrLayershell.namespace: "hyprscope-banner"

        // The banner only paints; it adds no MouseArea besides the stop button, so
        // pointer input outside the strip's controls is not consumed, and
        // WlrKeyboardFocus.None keeps the injected keyboard out of this surface.
        Rectangle {
            anchors.fill: parent
            color: "#e614161b"
            border.width: 1
            border.color: "#2c3038"

            Item {
                id: bannerBody
                anchors {
                    left: parent.left
                    right: parent.right
                    top: parent.top
                }
                height: bannerColumn.implicitHeight + 24

                Column {
                    id: bannerColumn
                    anchors {
                        left: parent.left
                        right: parent.right
                        top: parent.top
                        leftMargin: 16
                        rightMargin: 16
                        topMargin: 12
                    }
                    spacing: 6

                    Item {
                        id: bannerMain
                        width: parent.width
                        height: Math.max(mainRow.implicitHeight, stopButton.height)

                        Row {
                            id: mainRow
                            anchors {
                                left: parent.left
                                verticalCenter: parent.verticalCenter
                            }
                            spacing: 12

                            Rectangle {
                                width: 8
                                height: 8
                                radius: 4
                                color: root.accentColor()
                                anchors.verticalCenter: parent.verticalCenter
                            }

                            Text {
                                text: root.bannerTitle()
                                color: "#f2f4f8"
                                font.pixelSize: 14
                                font.bold: true
                                anchors.verticalCenter: parent.verticalCenter
                            }

                            Text {
                                visible: root.bannerSubtitle() !== ""
                                text: root.bannerSubtitle()
                                color: "#8b93a3"
                                font.pixelSize: 13
                                anchors.verticalCenter: parent.verticalCenter
                            }
                        }

                        Rectangle {
                            id: stopButton
                            visible: root.phase() === "granted"
                            width: 96
                            height: 32
                            radius: 8
                            color: stopArea.pressed ? "#7a2424" : "#8f2b2b"
                            anchors {
                                right: parent.right
                                verticalCenter: parent.verticalCenter
                            }
                            Text {
                                anchors.centerIn: parent
                                text: "立即收回"
                                color: "#ffffff"
                                font.pixelSize: 13
                            }
                            MouseArea {
                                id: stopArea
                                anchors.fill: parent
                                cursorShape: Qt.PointingHandCursor
                                onClicked: root.releaseNow()
                            }
                        }
                    }

                    Text {
                        width: parent.width
                        visible: root.progressLine() !== ""
                        text: root.progressLine()
                        color: root.accentColor()
                        font.pixelSize: 13
                        font.bold: true
                        elide: Text.ElideRight
                    }

                    Text {
                        width: parent.width
                        visible: root.planLine() !== ""
                        text: root.planLine()
                        color: "#7d8493"
                        font.pixelSize: 12
                        elide: Text.ElideRight
                    }

                    Rectangle {
                        width: parent.width
                        visible: root.noticeActive()
                        height: noticeLabel.implicitHeight + 12
                        radius: 6
                        color: "#26f5a623"
                        border.width: 1
                        border.color: "#66f5a623"

                        Text {
                            id: noticeLabel
                            anchors {
                                left: parent.left
                                right: parent.right
                                verticalCenter: parent.verticalCenter
                                leftMargin: 10
                                rightMargin: 10
                            }
                            text: root.noticeText()
                            color: "#f0c475"
                            font.pixelSize: 13
                            wrapMode: Text.WordWrap
                        }
                    }
                }
            }
        }
    }

    // Blocking interference prompt. It is declared after the banner so this
    // later layer-shell surface is stacked above the banner of the same layer.
    // The requested display name `hyprrelease-interference` is kept as the
    // object name; the layer-shell namespace (what the compositor sees) is
    // `hyprscope-interference`.
    PanelWindow {
        id: interferenceWindow
        objectName: "hyprrelease-interference"
        visible: root.interferenceActive()
        anchors {
            top: true
            left: true
            right: true
            bottom: true
        }
        exclusionMode: ExclusionMode.Ignore
        color: "#99000000"
        WlrLayershell.layer: WlrLayer.Overlay
        WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
        WlrLayershell.namespace: "hyprscope-interference"

        Rectangle {
            id: interferenceCard
            width: 560
            height: interferenceForm.implicitHeight + 56
            anchors.centerIn: parent
            radius: 16
            color: "#14161b"
            border.width: 1
            border.color: "#4a3a1e"

            Column {
                id: interferenceForm
                x: 28
                y: 28
                width: parent.width - 56
                spacing: 14

                Text {
                    text: "检测到外部操作"
                    color: "#f2f4f8"
                    font.pixelSize: 20
                    font.bold: true
                }

                Text {
                    width: parent.width
                    text: root.interferenceStepLine()
                    color: "#8b93a3"
                    font.pixelSize: 12
                }

                Text {
                    width: parent.width
                    visible: root.brokenLines().length === 0
                    text: root.interference && root.interference.detail
                        ? root.interference.detail
                        : "(未提供细节)"
                    color: "#c7ccd6"
                    font.pixelSize: 14
                    wrapMode: Text.WordWrap
                }

                Column {
                    width: parent.width
                    spacing: 2
                    visible: root.brokenLines().length > 0

                    Text {
                        width: parent.width
                        visible: root.brokenLineAt(0) !== ""
                        text: root.brokenLineAt(0)
                        color: "#c7ccd6"
                        font.pixelSize: 13
                        elide: Text.ElideRight
                    }

                    Text {
                        width: parent.width
                        visible: root.brokenLineAt(1) !== ""
                        text: root.brokenLineAt(1)
                        color: "#c7ccd6"
                        font.pixelSize: 13
                        elide: Text.ElideRight
                    }

                    Text {
                        width: parent.width
                        visible: root.brokenLineAt(2) !== ""
                        text: root.brokenLineAt(2)
                        color: "#c7ccd6"
                        font.pixelSize: 13
                        elide: Text.ElideRight
                    }

                    Text {
                        width: parent.width
                        visible: root.brokenExtraText() !== ""
                        text: root.brokenExtraText()
                        color: "#6f7684"
                        font.pixelSize: 12
                    }
                }

                Text {
                    width: parent.width
                    visible: root.interferenceContinueLine() !== ""
                    text: root.interferenceContinueLine()
                    color: "#aab3c2"
                    font.pixelSize: 13
                    wrapMode: Text.WordWrap
                }

                Text {
                    width: parent.width
                    text: root.interferenceCountdown()
                    color: "#e0a04c"
                    font.pixelSize: 12
                }

                Row {
                    spacing: 12
                    topPadding: 6

                    Rectangle {
                        width: 132
                        height: 42
                        radius: 9
                        color: abortArea.pressed ? "#2a2d35" : "#20232a"
                        border.width: 1
                        border.color: "#343945"
                        Text {
                            anchors.centerIn: parent
                            text: "终止操作"
                            color: "#d6dae4"
                            font.pixelSize: 14
                        }
                        MouseArea {
                            id: abortArea
                            anchors.fill: parent
                            cursorShape: Qt.PointingHandCursor
                            onClicked: root.resolveInterference("abort")
                        }
                    }

                    Rectangle {
                        width: 132
                        height: 42
                        radius: 9
                        color: continueArea.pressed ? "#3d6fe0" : "#4b7bec"
                        Text {
                            anchors.centerIn: parent
                            text: "继续执行"
                            color: "#ffffff"
                            font.pixelSize: 14
                            font.bold: true
                        }
                        MouseArea {
                            id: continueArea
                            anchors.fill: parent
                            cursorShape: Qt.PointingHandCursor
                            onClicked: root.resolveInterference("continue")
                        }
                    }
                }
            }

            Item {
                // Modal while the card is visible: Escape aborts, Return/Enter
                // continues. The MouseArea buttons above are not focusable, so the
                // keys land here.
                anchors.fill: parent
                focus: true
                Keys.onEscapePressed: root.resolveInterference("abort")
                Keys.onReturnPressed: root.resolveInterference("continue")
                Keys.onEnterPressed: root.resolveInterference("continue")
            }
        }
    }
}
