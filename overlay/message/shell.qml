// Desktop-message overlay: a small hint pill that says DSH is running with the
// hyprscope plugin, and a composer that hands one message to the running Host.
//
// The overlay never talks to DSH directly. It polls the message directory the
// DSH plugin and the CLI share: the plugin writes status.json (liveness,
// language, whether a screenshot is attached) and ack.json (injection receipt),
// while `hyprscope message open` writes open.json. The overlay writes one
// JSON document per composed message into outbox/ and nothing else, so a
// crashed or restarted overlay cannot inject twice: the plugin consumes each
// file exactly once.
import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland

ShellRoot {
    id: root

    // -- State written by the DSH plugin and the CLI ------------------------
    property var status: null
    // Recorded by install-bind; empty means no shortcut is installed yet, and
    // the pill says so instead of claiming a key that does nothing.
    property string shortcutKey: ""
    property string seenOpenNonce: ""
    property string seenQuitAt: ""
    property var ack: null

    // -- Local composer state ----------------------------------------------
    // "", "compose", "sending", "sent", "error" or "unavailable".
    property string phase: ""
    property string sendId: ""
    property string draftText: ""
    property string errorText: ""
    property real phaseSince: 0
    property bool hintHovered: false

    // -- Clock and liveness -------------------------------------------------
    property real startedAt: Date.now()
    property real nowMs: Date.now()
    property real lastStatusAt: 0
    property real lastActivityAt: Date.now()
    property bool everLive: false

    property string messageDir: Quickshell.env("HYPRSCOPE_MESSAGE_DIR") || ""
    property string language: Quickshell.env("HYPRSCOPE_MESSAGE_LANG") === "en" ? "en" : "zh"
    property bool hasDirectory: root.messageDir !== ""
    property string statusPath: root.hasDirectory ? root.messageDir + "/status.json" : ""
    property string openPath: root.hasDirectory ? root.messageDir + "/open.json" : ""
    property string ackPath: root.hasDirectory ? root.messageDir + "/ack.json" : ""
    property string quitPath: root.hasDirectory ? root.messageDir + "/quit.json" : ""
    property string shortcutPath: root.hasDirectory ? root.messageDir + "/shortcut.txt" : ""
    property string outboxDir: root.hasDirectory ? root.messageDir + "/outbox" : ""

    // A heartbeat older than this is not a running Host; the plugin refreshes it
    // every few seconds, so a stopped Host is visible within one window.
    property int staleMs: 20000
    // Give up after this long without a heartbeat, or after opening with no Host.
    property int idleQuitMs: 60000
    property int unbackedQuitMs: 25000
    // An open request older than this is stale; it must not pop the composer
    // when a fresh overlay starts after a crash.
    property int openRequestFreshMs: 15000

    // Every rendered string lives here so no line is hard-coded in one language.
    property var strings: ({
        zh: {
            hintRunning: "DSH 后台运行中",
            hintEnabled: "hyprscope 已启用",
            hintNoShortcut: "快捷键未安装",
            hintSent: "已发送",
            composerTitle: "给 DSH 发一条桌面消息",
            composerSubtitleShot: "发送时会附上当前桌面截图，agent 直接就能看到桌面。",
            composerSubtitlePlain: "发送后 agent 会收到这条消息。",
            placeholder: "现在要做什么？",
            sendHint: "Enter 发送 · Esc 取消",
            unavailableTitle: "DSH 未运行",
            unavailableBody: "后台没有正在运行的 DSH，桌面消息发不出去。启动 DSH 后再按一次快捷键。",
            unavailableClose: "Esc 关闭",
            errorWrite: "消息写入失败，请重试。",
            errorSend: "DSH 没有接收这条消息。",
            errorTimeout: "发送超时，请重试。"
        },
        en: {
            hintRunning: "DSH is running",
            hintEnabled: "hyprscope enabled",
            hintNoShortcut: "shortcut not installed",
            hintSent: "Sent",
            composerTitle: "Send a desktop message to DSH",
            composerSubtitleShot: "The current desktop screenshot travels with it, so the agent sees the desktop.",
            composerSubtitlePlain: "The agent will receive this message.",
            placeholder: "What should the agent do?",
            sendHint: "Enter to send · Esc to cancel",
            unavailableTitle: "DSH is not running",
            unavailableBody: "No DSH Host is running in the background, so the message cannot be sent. Start DSH and press the shortcut again.",
            unavailableClose: "Esc to close",
            errorWrite: "The message could not be written; try again.",
            errorSend: "DSH did not accept this message.",
            errorTimeout: "Sending timed out; try again."
        }
    })

    // -- Strings ------------------------------------------------------------
    function tr(key) {
        const table = root.strings[root.language] || root.strings.zh
        const text = table[key]
        return typeof text === "string" ? text : key
    }

    function fmt(key, values) {
        let text = root.tr(key)
        if (!values) return text
        const names = Object.keys(values)
        for (let index = 0; index < names.length; index += 1) {
            text = text.split("{" + names[index] + "}").join(String(values[names[index]]))
        }
        return text
    }

    // -- Parsing ------------------------------------------------------------
    function parseJson(text) {
        if (typeof text !== "string" || text.trim() === "") return null
        try {
            const parsed = JSON.parse(text)
            return parsed !== null && typeof parsed === "object" ? parsed : null
        } catch (error) {
            return null
        }
    }

    function applyStatus(text) {
        const parsed = root.parseJson(text)
        const valid = parsed !== null && parsed.version === 1
            && typeof parsed.alive === "boolean" && typeof parsed.updatedAt === "string"
        if (!valid) return
        root.status = parsed
        root.lastStatusAt = root.nowMs
        root.lastActivityAt = root.nowMs
        if (parsed.alive === true) root.everLive = true
    }

    function applyOpen(text) {
        const parsed = root.parseJson(text)
        if (parsed === null || typeof parsed.nonce !== "string" || parsed.nonce === "") return
        if (root.seenOpenNonce === parsed.nonce) return
        root.seenOpenNonce = parsed.nonce
        const at = Date.parse(parsed.at)
        const fresh = !isNaN(at) && root.nowMs - at <= root.openRequestFreshMs
        if (!fresh) return
        root.lastActivityAt = root.nowMs
        if (root.isAvailable()) root.openComposer()
        else root.showUnavailable()
    }

    function applyAck(text) {
        const parsed = root.parseJson(text)
        if (parsed === null || typeof parsed.id !== "string" || parsed.id !== root.sendId) return
        root.ack = parsed
        if (root.phase !== "sending") return
        root.lastActivityAt = root.nowMs
        if (parsed.ok === true) {
            root.phase = "sent"
            root.phaseSince = root.nowMs
            root.errorText = ""
        } else {
            root.phase = "error"
            root.phaseSince = root.nowMs
            root.errorText = typeof parsed.message === "string" && parsed.message !== ""
                ? parsed.message
                : root.tr("errorSend")
            root.restoreDraft()
        }
    }

    function applyShortcut(text) {
        const trimmed = typeof text === "string" ? text.trim() : ""
        if (trimmed !== "") root.shortcutKey = trimmed
    }

    function applyQuit(text) {
        const parsed = root.parseJson(text)
        if (parsed === null || typeof parsed.at !== "string") return
        if (root.seenQuitAt === parsed.at) return
        root.seenQuitAt = parsed.at
        const at = Date.parse(parsed.at)
        if (!isNaN(at) && root.nowMs - at <= root.openRequestFreshMs) Qt.quit()
    }

    // One reader prints five sections separated by a line holding only "---";
    // JSON documents never contain such a line, and a missing file contributes
    // an empty section which the appliers treat as absent.
    function applyPoll(text) {
        const separator = "
---
"
        const sections = []
        let rest = text
        for (let index = 0; index < 4; index += 1) {
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
        root.applyStatus(sections[0])
        root.applyOpen(sections[1])
        root.applyAck(sections[2])
        root.applyQuit(sections[3])
        root.applyShortcut(sections[4])
    }

    // -- Liveness and visibility -------------------------------------------
    function isAvailable() {
        if (root.status === null || root.status.alive !== true) return false
        const updated = Date.parse(root.status.updatedAt)
        if (isNaN(updated)) return false
        return root.nowMs - updated <= root.staleMs
    }

    function hintVisible() {
        return root.isAvailable() && (root.phase === "" || root.phase === "sent")
    }

    function hintState() {
        return root.phase === "sent" ? root.tr("hintSent") : root.tr("hintRunning")
    }

    // The pill is one rich-text line: a colored dot, the state, a divider, the
    // plugin fact and the bound key. HTML entities keep the gaps from collapsing.
    function hintRichText() {
        const gap = "&nbsp;&nbsp;"
        const dotColor = root.phase === "sent" ? "#7bd88f" : "#4ade80"
        const stateColor = root.phase === "sent" ? "#7bd88f" : "#e8ebf2"
        const shortcut = root.shortcutKey === ""
            ? '<font color="#e0a04c">' + root.tr("hintNoShortcut") + '</font>'
            : '<font color="#8fa8c8">' + root.shortcutLabel() + '</font>'
        return '<font color="' + dotColor + '">&#9679;</font>' + gap
            + '<font color="' + stateColor + '">' + root.hintState() + '</font>' + gap
            + '<font color="#3a3f4a">|</font>' + gap
            + '<font color="#9aa3b2">' + root.tr("hintEnabled") + '</font>' + gap
            + shortcut
    }

    function composerVisible() {
        return root.phase === "compose" || root.phase === "error" || root.phase === "unavailable"
    }

    function composerSubtitle() {
        return root.status !== null && root.status.attachScreenshot === true
            ? root.tr("composerSubtitleShot")
            : root.tr("composerSubtitlePlain")
    }

    // One compact badge for the hint: "SUPER + ALT + M" becomes "Super+Alt+M".
    function shortcutLabel() {
        if (root.shortcutKey === "") return ""
        // The key is interpolated into RichText; keep only the characters a
        // Hyprland combination uses so a hand-edited shortcut.txt cannot inject
        // markup into the pill.
        const safe = root.shortcutKey.replace(/[^A-Za-z0-9+ ]/g, "")
        const parts = safe.split("+").map(function(part) { return part.trim() }).filter(function(part) {
            return part !== ""
        })
        return parts.map(function(part) {
            const upper = part.toUpperCase()
            if (upper === "SUPER") return "Super"
            if (upper === "ALT") return "Alt"
            if (upper === "SHIFT") return "Shift"
            if (upper === "CTRL") return "Ctrl"
            return part
        }).join("+")
    }

    // -- Composer transitions ----------------------------------------------
    function openComposer() {
        if (root.phase === "sending") return
        root.phase = "compose"
        root.errorText = ""
        root.sendId = ""
        root.draftText = ""
        composerInput.text = ""
        Qt.callLater(function() { composerInput.forceActiveFocus() })
    }

    function showUnavailable() {
        if (root.phase === "sending") return
        root.phase = "unavailable"
        root.phaseSince = root.nowMs
    }

    function closeComposer() {
        if (root.phase === "sending") return
        root.phase = ""
        root.errorText = ""
        root.draftText = ""
        composerInput.text = ""
    }

    function restoreDraft() {
        if (composerInput.text === "" && root.draftText !== "") composerInput.text = root.draftText
        Qt.callLater(function() { composerInput.forceActiveFocus() })
    }

    // One message at a time: the composer writes a complete JSON document and
    // hides every overlay surface, so the screenshot the plugin takes right
    // after it reads the file shows the user's desktop, not this UI.
    function send() {
        if (root.phase !== "compose" && root.phase !== "error") return
        const text = composerInput.text.trim()
        if (text === "") return
        if (root.outboxDir === "") {
            root.phase = "error"
            root.errorText = root.tr("errorWrite")
            return
        }
        const id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8)
        const payload = JSON.stringify({ id: id, text: text, at: new Date().toISOString() })
        root.sendId = id
        root.draftText = text
        root.ack = null
        root.phase = "sending"
        root.phaseSince = root.nowMs
        composerInput.text = ""
        // FileView writes atomically: the plugin never reads a partial document.
        // The write waits one event-loop turn so the new path binding is applied
        // before setText resolves the destination.
        outboxFile.path = root.outboxDir + "/msg-" + id + ".json"
        Qt.callLater(function() { outboxFile.setText(payload) })
    }

    // -- Reading and ticking ------------------------------------------------
    Process {
        id: reader
        // One shell loop prints the five records separated by a bare "---" line;
        // a missing file contributes an empty record and the appliers ignore it.
        // The script uses no quoting beyond its arguments, and paths travel as
        // positional parameters so no path is ever re-parsed.
        command: ["sh", "-c",
            'first=1; for f in "$1" "$2" "$3" "$4" "$5"; do if [ "$first" = 0 ]; then echo; echo ---; fi; first=0; cat "$f" 2>/dev/null; done',
            "hyprscope-message-reader", root.statusPath, root.openPath, root.ackPath, root.quitPath, root.shortcutPath]
        stdout: StdioCollector {
            onStreamFinished: root.applyPoll(this.text)
        }
    }

    // The outbox write: atomic inside FileView, so the plugin only ever sees a
    // complete message document. Its path changes for every composed message.
    FileView {
        id: outboxFile
        path: ""
        atomicWrites: true
        printErrors: false
        onSaved: {}
        onSaveFailed: function(error) {
            if (root.phase !== "sending") return
            root.phase = "error"
            root.phaseSince = root.nowMs
            root.errorText = root.tr("errorWrite")
            root.restoreDraft()
        }
    }

    Timer {
        interval: 200
        repeat: true
        running: true
        onTriggered: {
            root.nowMs = Date.now()
            if (!reader.running) reader.running = true
            // Sent: show the receipt in the hint pill for a moment, then stand by.
            if (root.phase === "sent" && root.nowMs - root.phaseSince > 2200) root.phase = ""
            // A send that never gets an acknowledgement returns to the composer.
            if (root.phase === "sending" && root.nowMs - root.phaseSince > 20000) {
                root.phase = "error"
                root.phaseSince = root.nowMs
                root.errorText = root.tr("errorTimeout")
                root.restoreDraft()
            }
            if (root.phase === "unavailable" && root.nowMs - root.phaseSince > 6000) root.phase = ""
            // Exit when the Host is gone, or when an overlay opened without one
            // never becomes useful.
            const lastSeen = Math.max(root.startedAt, root.lastStatusAt, root.lastActivityAt)
            if (root.everLive && root.nowMs - root.lastStatusAt > root.idleQuitMs) Qt.quit()
            else if (!root.everLive && root.nowMs - root.startedAt > root.unbackedQuitMs) Qt.quit()
            else if (!root.everLive && root.nowMs - lastSeen > root.unbackedQuitMs) Qt.quit()
        }
    }

    // -- The hint pill ------------------------------------------------------
    PanelWindow {
        id: hintWindow
        visible: root.hintVisible()
        anchors {
            top: true
            right: true
        }
        margins {
            top: 10
            right: 16
        }
        implicitWidth: hintPill.width
        implicitHeight: hintPill.height
        exclusionMode: ExclusionMode.Ignore
        color: "transparent"
        WlrLayershell.layer: WlrLayer.Overlay
        WlrLayershell.keyboardFocus: WlrKeyboardFocus.None
        WlrLayershell.namespace: "hyprscope-message-hint"

        Rectangle {
            id: hintPill
            // One rich-text line owns the whole content, so the pill width is
            // exact and no positioner decides where a segment sits vertically.
            implicitWidth: hintText.contentWidth + 34
            implicitHeight: 30
            radius: 15
            color: "#e614161b"
            border.width: 1
            border.color: root.hintHovered ? "#434a58" : "#2c3038"
            opacity: root.hintHovered ? 1.0 : 0.92

            Text {
                id: hintText
                anchors.centerIn: parent
                textFormat: Text.RichText
                text: root.hintRichText()
                color: "#e8ebf2"
                font.pixelSize: 12
            }

            MouseArea {
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onEntered: root.hintHovered = true
                onExited: root.hintHovered = false
                onClicked: {
                    if (root.isAvailable()) root.openComposer()
                    else root.showUnavailable()
                }
            }
        }
    }

    // -- The composer -------------------------------------------------------
    // The scrim and the card are one keyboard-exclusive surface while it is up;
    // when it hides for a send, focus returns to the user's window.
    PanelWindow {
        id: composerWindow
        visible: root.composerVisible()
        anchors {
            top: true
            left: true
            right: true
            bottom: true
        }
        exclusionMode: ExclusionMode.Ignore
        color: "#80000000"
        WlrLayershell.layer: WlrLayer.Overlay
        WlrLayershell.keyboardFocus: root.composerVisible() ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None
        WlrLayershell.namespace: "hyprscope-message-composer"

        Rectangle {
            width: 620
            height: composerForm.implicitHeight + 52
            anchors.centerIn: parent
            radius: 16
            color: "#14161b"
            border.width: 1
            border.color: "#2c3038"

            Column {
                id: composerForm
                x: 26
                y: 24
                width: parent.width - 52
                spacing: 14

                Text {
                    width: parent.width
                    text: root.phase === "unavailable" ? root.tr("unavailableTitle") : root.tr("composerTitle")
                    color: "#f2f4f8"
                    font.pixelSize: 18
                    font.bold: true
                }

                Text {
                    width: parent.width
                    visible: root.phase !== "unavailable"
                    text: root.composerSubtitle()
                    color: "#8b93a3"
                    font.pixelSize: 12
                    wrapMode: Text.WordWrap
                }

                Text {
                    width: parent.width
                    visible: root.phase === "unavailable"
                    text: root.tr("unavailableBody")
                    color: "#c7ccd6"
                    font.pixelSize: 13
                    wrapMode: Text.WordWrap
                }

                Rectangle {
                    width: parent.width
                    height: 46
                    radius: 9
                    visible: root.phase !== "unavailable"
                    color: "#0d0f13"
                    border.width: 1
                    border.color: composerInput.activeFocus ? "#4b7bec" : "#2c3038"

                    TextInput {
                        id: composerInput
                        anchors.fill: parent
                        anchors.leftMargin: 14
                        anchors.rightMargin: 14
                        verticalAlignment: TextInput.AlignVCenter
                        color: "#f2f4f8"
                        font.pixelSize: 15
                        selectionColor: "#2f4f9e"
                        selectedTextColor: "#ffffff"
                        focus: root.phase === "compose" || root.phase === "error"
                        clip: true
                        onAccepted: root.send()
                        Keys.onEscapePressed: root.closeComposer()

                        Text {
                            anchors.verticalCenter: parent.verticalCenter
                            visible: composerInput.text === "" && !composerInput.inputMethodComposing
                            text: root.tr("placeholder")
                            color: "#5d6472"
                            font.pixelSize: 15
                        }
                    }
                }

                Text {
                    width: parent.width
                    visible: root.phase === "compose" || root.phase === "error"
                    text: root.phase === "error" ? root.errorText : root.tr("sendHint")
                    color: root.phase === "error" ? "#e0a04c" : "#6f7684"
                    font.pixelSize: 12
                    wrapMode: Text.WordWrap
                }

                Text {
                    width: parent.width
                    visible: root.phase === "unavailable"
                    text: root.tr("unavailableClose")
                    color: "#6f7684"
                    font.pixelSize: 12
                }
            }

            // The unavailable card owns the keyboard so Esc can close it; the
            // text field owns the keys itself while it is up.
            Item {
                anchors.fill: parent
                focus: root.phase === "unavailable"
                Keys.onEscapePressed: root.closeComposer()
            }
        }
    }
}
