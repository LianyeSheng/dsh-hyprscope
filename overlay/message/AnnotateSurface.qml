// Desktop annotation surface: freeze-frame screenshot, drawing tools, push-to-talk
// voice, and a review card that submits the session to the running DSH Host.
//
// Like the composer in shell.qml, this surface never talks to DSH directly and
// never touches the desktop. It only reads the files the plugin writes inside
// the annotate session directory (active.json, session.json, voice/<id>.json,
// ack.json, error.json) and writes the files it owns (annotations.json,
// voice-events.json, send.json, cancel.json), atomically through FileView.
//
// Everything stays in image pixels in the files: annotations.json from/to are
// capture.png pixels, while the UI draws them scaled by 1/scale. The display
// rectangle is capture.width/scale by capture.height/scale, so a mouse position
// inside that rectangle converts to image pixels with mouse * scale.
import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland

PanelWindow {
    id: root

    // -- Inputs from shell.qml ----------------------------------------------
    property string messageDir: ""
    // The overlay language is a hint; session.json.language wins once known.
    property string hintLanguage: "zh"

    // -- Output -------------------------------------------------------------
    // "sent" or "cancelled"; shell.qml unloads this surface and cleans up.
    signal finished(string outcome)

    // -- Session state (contract section 9) --------------------------------
    // loading -> annotating -> review -> sending -> sent | error | cancelled
    property string phase: "loading"
    property string language: hintLanguage
    property var active: null
    property var session: null
    property string sessionDir: ""
    property real startedAt: 0
    property real loadingStartedAt: Date.now()
    property bool finishedEmitted: false

    // -- Timing knobs from the contract ------------------------------------
    property int loadingTimeoutMs: 5000
    property int voiceTimeoutMs: 15000
    property int sendTimeoutMs: 20000
    property int maxVoiceMs: 60000
    property int sentCloseMs: 1500

    // -- Paths (bindings; sessionDir is set once active.json is read) ------
    property string activePath: root.messageDir !== "" ? root.messageDir + "/annotate/active.json" : ""
    property string sessionPath: root.sessionDir !== "" ? root.sessionDir + "/session.json" : ""
    property string annotationsPath: root.sessionDir !== "" ? root.sessionDir + "/annotations.json" : ""
    property string voiceEventsPath: root.sessionDir !== "" ? root.sessionDir + "/voice-events.json" : ""
    property string sendPath: root.sessionDir !== "" ? root.sessionDir + "/send.json" : ""
    property string ackPath: root.sessionDir !== "" ? root.sessionDir + "/ack.json" : ""
    property string cancelPath: root.sessionDir !== "" ? root.sessionDir + "/cancel.json" : ""
    property string errorPath: root.sessionDir !== "" ? root.sessionDir + "/error.json" : ""

    // -- Capture and coordinate mapping ------------------------------------
    readonly property var capture: root.session !== null && root.session.capture ? root.session.capture : null
    readonly property real scale: root.capture !== null && typeof root.capture.scale === "number"
        && root.capture.scale > 0 ? root.capture.scale : 1
    readonly property int screenX: root.screen !== null && root.screen !== undefined ? root.screen.x : 0
    readonly property int screenY: root.screen !== null && root.screen !== undefined ? root.screen.y : 0
    property var targetScreen: null
    property string captureUrl: ""
    // The image is drawn at logical size: width/scale, height/scale. layoutRect
    // is in global layout coordinates, so subtract the panel screen origin.
    readonly property real imageX: root.capture !== null && root.capture.layoutRect
        && root.capture.layoutRect.length >= 4 ? root.capture.layoutRect[0] - root.screenX : 0
    readonly property real imageY: root.capture !== null && root.capture.layoutRect
        && root.capture.layoutRect.length >= 4 ? root.capture.layoutRect[1] - root.screenY : 0
    readonly property real imageW: root.capture !== null && root.capture.width > 0 ? root.capture.width / root.scale : 0
    readonly property real imageH: root.capture !== null && root.capture.height > 0 ? root.capture.height / root.scale : 0

    // -- Annotation model ---------------------------------------------------
    property var annotations: []
    property var undoStack: []
    property string selectedId: ""
    property string tool: "rect"
    property bool drawing: false
    property string draftId: ""
    property real draftAtStart: 0
    property int annotationCounter: 0
    property bool commentSync: false

    // -- Voice model --------------------------------------------------------
    property var voices: []
    property int voiceCounter: 0
    property var voiceFiles: ({})
    property bool listening: false
    property string listeningId: ""
    property real listeningAtStart: 0
    property string liveVoiceId: ""
    property bool liveVoiceSync: false

    // -- Pointer, transient UI ---------------------------------------------
    property real pointerX: 0
    property real pointerY: 0
    property bool pointerSeen: false
    property string toast: ""
    property real toastAt: 0
    property bool confirmCancel: false

    // -- Review and submission ---------------------------------------------
    property string overallNote: ""
    property bool sending: false
    property real phaseStartedAt: 0
    property real sentAt: 0
    property string ackMessage: ""
    property real sendStartedAt: 0
    property real lastAckReload: 0
    property bool cancelRequested: false

    // -- Error state --------------------------------------------------------
    property string errorKind: ""
    property string errorText: ""
    property bool errorRetryable: false

    // -- Clock --------------------------------------------------------------
    property real nowMs: Date.now()

    // -- Strings ------------------------------------------------------------
    property var strings: ({
        zh: {
            loadFailed: "无法读取标注会话",
            errorLoad: "标注会话没有在 5 秒内准备好。DSH 可能不在运行，请重试。",
            errorSession: "标注会话数据不完整，无法显示截图。",
            errorImage: "无法读取冻结截图。",
            errorWrite: "写入标注失败，请重试。",
            errorTitle: "出错了",
            sendFailed: "发送失败",
            errorSend: "DSH 没有接收这次标注。",
            errorTimeout: "发送超时，请重试。",
            retry: "重试",
            backToReview: "返回审查",
            close: "关闭",
            cancel: "取消",
            toolRect: "矩形",
            toolEllipse: "椭圆",
            toolArrow: "箭头",
            toolSelect: "选择",
            undo: "撤销",
            clear: "清空",
            send: "发送",
            annotateHint: "按住 Space 说话 · Enter 检查 · Esc 取消",
            reviewTitle: "检查并发送",
            reviewSubtitle: "{n} 个标注 · {m} 段语音",
            reviewHint: "Enter 发送 · Esc 返回标注",
            sectionAnnotations: "标注",
            sectionVoices: "语音",
            sectionNote: "整体备注",
            liveVoiceHint: "可直接修改转写 · Enter 检查并发送",
            liveVoicePlaceholder: "转写文本（可编辑）",
            noAnnotations: "还没有标注。Esc 返回画布添加。",
            noVoices: "还没有语音。按住 Space 说话。",
            commentPlaceholder: "给这个标注补充说明（可留空）",
            overallPlaceholder: "还有什么要补充的？（可选）",
            editComment: "编辑 #{n} 的评论",
            delete: "删除",
            done: "完成",
            clickEmpty: "点击空白处取消选择",
            listening: "正在听",
            binding: "绑定 #{n}",
            globalNote: "全局备注",
            autoBind: "自动",
            bindLabel: "绑定",
            transcribing: "转写中…",
            transcribed: "已转写",
            transcriptionFailed: "转写失败，请直接输入",
            confirmCancelTitle: "放弃这次标注？",
            confirmCancelBody: "已画的标注和语音都会丢弃，截图不会发送。",
            keepEditing: "继续编辑",
            discard: "放弃",
            sendingTitle: "正在发送…",
            sendingBody: "DSH 会收到冻结截图、标注几何和语音文本。",
            sentTitle: "已发送",
            sentClosing: "即将关闭…",
            voiceFailedToast: "转写失败，请直接输入",
            writeFailedToast: "写入失败，请重试",
            shapeRect: "矩形",
            shapeEllipse: "椭圆",
            shapeArrow: "箭头",
            timeRange: "{a}–{b}",
            reviewSend: "发送给 DSH",
            reviewBack: "返回标注",
            noVoiceText: "（没有文本）",
            annotationLabel: "#{n}",
            voiceLabel: "语音",
            waitingForSession: "正在准备标注…"
        },
        en: {
            loadFailed: "Cannot open the annotation session",
            errorLoad: "The annotation session was not ready within 5 seconds. DSH may not be running; try again.",
            errorSession: "The annotation session data is incomplete, so the screenshot cannot be shown.",
            errorImage: "Cannot read the frozen screenshot.",
            errorWrite: "The annotation could not be written; try again.",
            errorTitle: "Something went wrong",
            sendFailed: "Sending failed",
            errorSend: "DSH did not accept this annotation.",
            errorTimeout: "Sending timed out; try again.",
            retry: "Retry",
            backToReview: "Back to review",
            close: "Close",
            cancel: "Cancel",
            toolRect: "Rect",
            toolEllipse: "Ellipse",
            toolArrow: "Arrow",
            toolSelect: "Select",
            undo: "Undo",
            clear: "Clear",
            send: "Send",
            annotateHint: "Hold Space to talk · Enter to review · Esc to cancel",
            reviewTitle: "Review and send",
            reviewSubtitle: "{n} annotations · {m} speech segments",
            reviewHint: "Enter to send · Esc to keep annotating",
            sectionAnnotations: "Annotations",
            sectionVoices: "Speech",
            sectionNote: "Overall note",
            liveVoiceHint: "Edit the transcript if needed · Enter to review",
            liveVoicePlaceholder: "Transcript (editable)",
            noAnnotations: "No annotations yet. Press Esc to go back and add one.",
            noVoices: "No speech yet. Hold Space while annotating.",
            commentPlaceholder: "Add a note for this annotation (optional)",
            overallPlaceholder: "Anything else to add? (optional)",
            editComment: "Edit the comment for #{n}",
            delete: "Delete",
            done: "Done",
            clickEmpty: "Click empty space to deselect",
            listening: "Listening",
            binding: "bound to #{n}",
            globalNote: "Global note",
            autoBind: "Auto",
            bindLabel: "Bind",
            transcribing: "Transcribing…",
            transcribed: "Transcribed",
            transcriptionFailed: "Transcription failed, type the text instead",
            confirmCancelTitle: "Discard this annotation?",
            confirmCancelBody: "Every drawing and speech segment will be discarded; the screenshot is not sent.",
            keepEditing: "Keep editing",
            discard: "Discard",
            sendingTitle: "Sending…",
            sendingBody: "DSH receives the frozen screenshot, the annotation geometry and the speech text.",
            sentTitle: "Sent",
            sentClosing: "Closing…",
            voiceFailedToast: "Transcription failed, type the text instead",
            writeFailedToast: "Writing failed; try again",
            shapeRect: "rect",
            shapeEllipse: "ellipse",
            shapeArrow: "arrow",
            timeRange: "{a}–{b}",
            reviewSend: "Send to DSH",
            reviewBack: "Back to annotate",
            noVoiceText: "(no text)",
            annotationLabel: "#{n}",
            voiceLabel: "Speech",
            waitingForSession: "Preparing the annotation…"
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

    function parseJson(text) {
        if (typeof text !== "string" || text.trim() === "") return null
        try {
            const parsed = JSON.parse(text)
            return parsed !== null && typeof parsed === "object" ? parsed : null
        } catch (error) {
            return null
        }
    }

    // -- Screens and coordinates -------------------------------------------
    function findTargetScreen() {
        const name = root.session !== null && root.session.capture ? root.session.capture.monitor : ""
        const screens = Quickshell.screens || []
        for (let index = 0; index < screens.length; index += 1) {
            if (screens[index].name === name) return screens[index]
        }
        return null
    }

    function fileUrl(path) {
        if (typeof path !== "string" || path === "") return ""
        if (path.indexOf("file://") === 0) return path
        const parts = path.split("/")
        for (let index = 0; index < parts.length; index += 1) parts[index] = encodeURIComponent(parts[index])
        return "file://" + parts.join("/")
    }

    function globalCenterX() {
        if (root.capture === null || !root.capture.layoutRect || root.capture.layoutRect.length < 4) return 0
        return root.capture.layoutRect[0] + root.capture.layoutRect[2] / 2
    }

    function globalCenterY() {
        if (root.capture === null || !root.capture.layoutRect || root.capture.layoutRect.length < 4) return 0
        return root.capture.layoutRect[1] + root.capture.layoutRect[3] / 2
    }

    function pointerGlobalX() {
        return root.pointerSeen ? root.screenX + root.pointerX : root.globalCenterX()
    }

    function pointerGlobalY() {
        return root.pointerSeen ? root.screenY + root.pointerY : root.globalCenterY()
    }

    function imageToGlobalX(imageX) {
        if (root.capture === null) return 0
        return root.capture.layoutRect[0] + imageX / root.scale
    }

    function imageToGlobalY(imageY) {
        if (root.capture === null) return 0
        return root.capture.layoutRect[1] + imageY / root.scale
    }

    function clampImageX(value) {
        if (root.capture === null) return 0
        return Math.max(0, Math.min(root.capture.width, value))
    }

    function clampImageY(value) {
        if (root.capture === null) return 0
        return Math.max(0, Math.min(root.capture.height, value))
    }

    function updatePointer(localX, localY) {
        root.pointerX = localX
        root.pointerY = localY
        root.pointerSeen = true
    }

    function windowAt(globalX, globalY) {
        if (root.session === null || !root.session.context || !root.session.context.windows) return ""
        const windows = root.session.context.windows
        for (let index = windows.length - 1; index >= 0; index -= 1) {
            const rect = windows[index].rect
            if (!rect || rect.length < 4) continue
            if (globalX >= rect[0] && globalX < rect[0] + rect[2]
                && globalY >= rect[1] && globalY < rect[1] + rect[3]) return windows[index].id
        }
        return ""
    }

    // -- Model helpers ------------------------------------------------------
    function findAnnotation(id) {
        for (let index = 0; index < root.annotations.length; index += 1) {
            if (root.annotations[index].id === id) return root.annotations[index]
        }
        return null
    }

    function selectedAnnotation() {
        return root.findAnnotation(root.selectedId)
    }

    function findVoice(id) {
        for (let index = 0; index < root.voices.length; index += 1) {
            if (root.voices[index].id === id) return root.voices[index]
        }
        return null
    }

    function lastVoice() {
        return root.voices.length > 0 ? root.voices[root.voices.length - 1] : null
    }

    // Keep the compact annotating-mode voice card in sync with the newest
    // segment. A user edit inside that card wins over a later transcript.
    function syncLiveVoiceEditor() {
        const voice = root.lastVoice()
        root.liveVoiceSync = true
        if (voice === null) {
            root.liveVoiceId = ""
            liveVoiceInput.text = ""
        } else if (voice.id !== root.liveVoiceId || !voice.edited) {
            root.liveVoiceId = voice.id
            liveVoiceInput.text = voice.text || ""
        }
        root.liveVoiceSync = false
    }

    function renumber() {
        for (let index = 0; index < root.annotations.length; index += 1) root.annotations[index].index = index + 1
    }

    function pushUndo() {
        root.undoStack = root.undoStack.concat([JSON.stringify(root.annotations)])
        if (root.undoStack.length > 50) root.undoStack = root.undoStack.slice(root.undoStack.length - 50)
    }

    function shapeLabel(shape) {
        if (shape === "ellipse") return root.tr("shapeEllipse")
        if (shape === "arrow") return root.tr("shapeArrow")
        return root.tr("shapeRect")
    }

    function relativeSeconds(at) {
        return (Math.round((at - root.startedAt) / 100) / 10).toFixed(1) + "s"
    }

    function timeRange(atStart, atEnd) {
        return root.fmt("timeRange", {
            a: root.relativeSeconds(atStart),
            b: root.relativeSeconds(atEnd > atStart ? atEnd : atStart)
        })
    }

    function toolItems() {
        return [
            { key: "rect", label: root.tr("toolRect") },
            { key: "ellipse", label: root.tr("toolEllipse") },
            { key: "arrow", label: root.tr("toolArrow") },
            { key: "select", label: root.tr("toolSelect") }
        ]
    }

    function actionItems() {
        return [
            { key: "undo", label: root.tr("undo"), enabled: root.annotations.length > 0 || root.drawing },
            { key: "clear", label: root.tr("clear"), enabled: root.annotations.length > 0 },
            { key: "cancel", label: root.tr("cancel"), enabled: true },
            { key: "review", label: root.tr("send"), enabled: root.canReview() }
        ]
    }

    // -- Annotation I/O -----------------------------------------------------
    function annotationPayload(item) {
        const payload = {
            id: item.id,
            index: item.index,
            shape: item.shape,
            from: [Math.round(item.from[0]), Math.round(item.from[1])],
            to: [Math.round(item.to[0]), Math.round(item.to[1])],
            atStart: Math.round(item.atStart),
            atEnd: Math.round(item.atEnd > item.atStart ? item.atEnd : item.atStart),
            comment: typeof item.comment === "string" ? item.comment : ""
        }
        if (typeof item.windowId === "string" && item.windowId !== "") payload.windowId = item.windowId
        return payload
    }

    function annotationsJson() {
        const items = []
        for (let index = 0; index < root.annotations.length; index += 1) {
            items.push(root.annotationPayload(root.annotations[index]))
        }
        return JSON.stringify({ version: 1, items: items })
    }

    function writeAnnotations() {
        if (root.annotationsPath === "" || root.session === null) return
        annotationsFile.path = root.annotationsPath
        annotationsFile.setText(root.annotationsJson())
    }

    function scheduleAnnotationsWrite() {
        if (root.annotationsPath === "") return
        annotationWriteTimer.restart()
    }

    function requestShapePaint() {
        shapeCanvas.requestPaint()
    }

    // -- Voice I/O ----------------------------------------------------------
    function voiceEventsJson() {
        const segments = []
        for (let index = 0; index < root.voices.length; index += 1) {
            const voice = root.voices[index]
            const segment = {
                id: voice.id,
                atStart: Math.round(voice.atStart),
                atEnd: Math.round(voice.atEnd > voice.atStart ? voice.atEnd : voice.atStart)
            }
            if (voice.anchor) {
                const anchor = { x: Math.round(voice.anchor.x), y: Math.round(voice.anchor.y) }
                if (typeof voice.anchor.windowId === "string" && voice.anchor.windowId !== "") anchor.windowId = voice.anchor.windowId
                if (typeof voice.anchor.annotationId === "string" && voice.anchor.annotationId !== "") anchor.annotationId = voice.anchor.annotationId
                segment.anchor = anchor
            }
            segments.push(segment)
        }
        return JSON.stringify({ version: 1, segments: segments })
    }

    function writeVoiceEvents() {
        if (root.voiceEventsPath === "" || root.session === null) return
        voiceEventsFile.path = root.voiceEventsPath
        voiceEventsFile.setText(root.voiceEventsJson())
    }

    function voicePath(id) {
        return root.sessionDir !== "" ? root.sessionDir + "/voice/" + id + ".json" : ""
    }

    function ensureVoiceFile(id) {
        if (root.voiceFiles[id] !== undefined) return
        const file = voiceFileComponent.createObject(root, { path: root.voicePath(id) })
        if (file !== null) {
            // objectName carries the segment id into the FileView handlers.
            file.objectName = id
            root.voiceFiles[id] = file
        }
    }

    function voiceTextOf(parsed) {
        if (typeof parsed.text === "string" && parsed.text.trim() !== "") return parsed.text
        if (Array.isArray(parsed.phrases)) {
            const parts = []
            for (let index = 0; index < parsed.phrases.length; index += 1) {
                const phrase = parsed.phrases[index]
                if (phrase && typeof phrase.text === "string" && phrase.text.trim() !== "") parts.push(phrase.text)
            }
            if (parts.length > 0) return parts.join(" ")
        }
        return typeof parsed.text === "string" ? parsed.text : ""
    }

    function applyVoiceFile(id, text) {
        if (root.phase === "sent" || root.phase === "cancelled") return
        const voice = root.findVoice(id)
        if (voice === null || (voice.state !== "pending" && voice.state !== "recording")) return
        const parsed = root.parseJson(text)
        if (parsed === null || parsed.id !== id) return
        const value = root.voiceTextOf(parsed)
        const failed = typeof parsed.error === "string" && parsed.error !== "" && value.trim() === ""
        if (typeof parsed.seconds === "number") voice.seconds = parsed.seconds
        if (failed) {
            voice.state = "failed"
            voice.error = parsed.error
            root.showToast(root.tr("voiceFailedToast"))
        } else {
            voice.state = "ready"
            voice.error = ""
            if (!voice.edited) voice.text = value
        }
        root.voices = root.voices.slice()
        root.syncLiveVoiceEditor()
    }

    function pollVoices() {
        for (let index = 0; index < root.voices.length; index += 1) {
            const voice = root.voices[index]
            if (voice.state !== "pending") continue
            root.ensureVoiceFile(voice.id)
            const file = root.voiceFiles[voice.id]
            if (file !== undefined) file.reload()
        }
    }

    function hasPendingVoices() {
        for (let index = 0; index < root.voices.length; index += 1) {
            if (root.voices[index].state === "pending") return true
        }
        return false
    }

    function hasRecordingVoice() {
        for (let index = 0; index < root.voices.length; index += 1) {
            if (root.voices[index].state === "recording") return true
        }
        return false
    }

    function canSubmit() {
        return !root.listening && !root.drawing && !root.hasRecordingVoice() && !root.hasPendingVoices()
    }

    function canReview() {
        return !root.drawing && !root.listening && !root.hasRecordingVoice()
    }

    function currentAnchor() {
        const globalX = root.pointerGlobalX()
        const globalY = root.pointerGlobalY()
        const anchor = { x: Math.round(globalX), y: Math.round(globalY) }
        const windowId = root.windowAt(globalX, globalY)
        if (windowId !== "") anchor.windowId = windowId
        const annotation = root.selectedAnnotation()
        if (annotation !== null) anchor.annotationId = annotation.id
        else if (root.drawing && root.draftId !== "") anchor.annotationId = root.draftId
        return anchor
    }

    function startVoice() {
        if (root.phase !== "annotating" || root.listening) return
        if (root.session === null) return
        root.voiceCounter += 1
        const id = "v" + root.voiceCounter
        const at = Date.now()
        const anchor = root.currentAnchor()
        const autoAnnotationId = typeof anchor.annotationId === "string" ? anchor.annotationId : ""
        const voice = {
            id: id,
            atStart: at,
            atEnd: at,
            anchor: anchor,
            autoAnnotationId: autoAnnotationId,
            bindingMode: "auto",
            text: "",
            seconds: 0,
            state: "recording",
            error: "",
            edited: false
        }
        root.voices = root.voices.concat([voice])
        root.listening = true
        root.listeningId = id
        root.listeningAtStart = at
        root.writeVoiceEvents()
        root.ensureVoiceFile(id)
    }

    function stopVoice() {
        if (!root.listening) return
        const voice = root.findVoice(root.listeningId)
        root.listening = false
        root.listeningId = ""
        if (voice === null) return
        voice.atEnd = Math.max(Date.now(), voice.atStart + 1)
        voice.state = "pending"
        root.voices = root.voices.slice()
        root.writeVoiceEvents()
        root.syncLiveVoiceEditor()
    }

    function setVoiceBinding(id, mode) {
        const voice = root.findVoice(id)
        if (voice === null) return
        voice.bindingMode = mode
        if (voice.anchor) {
            if (mode === "auto") {
                if (voice.autoAnnotationId !== "") voice.anchor.annotationId = voice.autoAnnotationId
                else delete voice.anchor.annotationId
            } else if (mode === "global") {
                delete voice.anchor.annotationId
            } else {
                voice.anchor.annotationId = mode
            }
        }
        root.voices = root.voices.slice()
        root.writeVoiceEvents()
    }

    function bindingOptions() {
        const options = [{ id: "global", label: root.tr("globalNote") }, { id: "auto", label: root.tr("autoBind") }]
        for (let index = 0; index < root.annotations.length; index += 1) {
            const annotation = root.annotations[index]
            options.push({ id: annotation.id, label: "#" + annotation.index })
        }
        return options
    }

    function voiceBindingMatches(voice, optionId) {
        if (voice === undefined || voice === null) return false
        if (optionId === "auto") return voice.bindingMode === "auto"
        if (optionId === "global") return voice.bindingMode === "global"
        return voice.bindingMode === optionId
    }

    function voiceStatus(voice) {
        if (voice.state === "recording") return root.tr("listening")
        if (voice.state === "pending") return root.tr("transcribing")
        if (voice.state === "failed") return root.tr("transcriptionFailed")
        return root.tr("transcribed")
    }

    function voiceStatusColor(voice) {
        if (voice.state === "failed") return "#e0a04c"
        if (voice.state === "ready") return "#7bd88f"
        return "#8b93a3"
    }

    function liveVoiceIdText() {
        const voice = root.lastVoice()
        return voice === null ? "" : voice.id
    }

    function liveVoiceStatusText() {
        const voice = root.lastVoice()
        return voice === null ? "" : root.voiceStatus(voice)
    }

    function liveVoiceStatusColor() {
        const voice = root.lastVoice()
        return voice === null ? "#8b93a3" : root.voiceStatusColor(voice)
    }

    function liveVoiceFailed() {
        const voice = root.lastVoice()
        return voice !== null && voice.state === "failed"
    }

    function listeningText() {
        const annotation = root.selectedAnnotation()
        if (annotation !== null) {
            return root.tr("listening") + " · " + root.fmt("binding", { n: annotation.index })
        }
        return root.tr("listening") + " · " + root.tr("globalNote")
    }

    function commentTitle() {
        const item = root.selectedAnnotation()
        return item === null ? root.tr("editComment").split("{n}").join("?")
            : root.fmt("editComment", { n: item.index })
    }

    // -- Drawing ------------------------------------------------------------
    function annotationAt(imageX, imageY) {
        const tolerance = 6 * root.scale
        for (let index = root.annotations.length - 1; index >= 0; index -= 1) {
            const item = root.annotations[index]
            if (!item.from || !item.to) continue
            const x1 = Math.min(item.from[0], item.to[0])
            const x2 = Math.max(item.from[0], item.to[0])
            const y1 = Math.min(item.from[1], item.to[1])
            const y2 = Math.max(item.from[1], item.to[1])
            if (item.shape === "arrow") {
                const dx = item.to[0] - item.from[0]
                const dy = item.to[1] - item.from[1]
                const length = Math.sqrt(dx * dx + dy * dy)
                if (length < 1) continue
                const t = Math.max(0, Math.min(1, ((imageX - item.from[0]) * dx + (imageY - item.from[1]) * dy) / (length * length)))
                const nearestX = item.from[0] + t * dx
                const nearestY = item.from[1] + t * dy
                const distance = Math.sqrt((imageX - nearestX) * (imageX - nearestX) + (imageY - nearestY) * (imageY - nearestY))
                if (distance <= tolerance) return item
            } else if (imageX >= x1 - tolerance && imageX <= x2 + tolerance
                && imageY >= y1 - tolerance && imageY <= y2 + tolerance) {
                return item
            }
        }
        return null
    }

    function selectAt(imageX, imageY) {
        const item = root.annotationAt(imageX, imageY)
        root.selectedId = item === null ? "" : item.id
        root.syncCommentEditor()
        root.requestShapePaint()
        root.focusSurface()
    }

    function selectAnnotation(id) {
        root.selectedId = id
        root.syncCommentEditor()
        root.requestShapePaint()
        root.focusSurface()
    }

    function syncCommentEditor() {
        root.commentSync = true
        const item = root.selectedAnnotation()
        commentInput.text = item === null ? "" : (item.comment || "")
        root.commentSync = false
    }

    function beginDraw(localX, localY) {
        if (root.phase !== "annotating" || root.capture === null) return
        const imageX = root.clampImageX(localX * root.scale)
        const imageY = root.clampImageY(localY * root.scale)
        if (root.tool === "select") {
            root.selectAt(imageX, imageY)
            return
        }
        root.pushUndo()
        root.annotationCounter += 1
        const id = "a" + root.annotationCounter
        const at = Date.now()
        const windowId = root.windowAt(root.imageToGlobalX(imageX), root.imageToGlobalY(imageY))
        const item = {
            id: id,
            index: root.annotations.length + 1,
            shape: root.tool,
            from: [imageX, imageY],
            to: [imageX, imageY],
            atStart: at,
            atEnd: at,
            comment: "",
            windowId: windowId
        }
        root.annotations = root.annotations.concat([item])
        root.drawing = true
        root.draftId = id
        root.draftAtStart = at
        root.selectedId = ""
        root.syncCommentEditor()
        root.writeAnnotations()
        root.requestShapePaint()
    }

    function updateDraw(localX, localY) {
        if (!root.drawing) return
        const item = root.findAnnotation(root.draftId)
        if (item === null) return
        item.to[0] = root.clampImageX(localX * root.scale)
        item.to[1] = root.clampImageY(localY * root.scale)
        item.atEnd = Date.now()
        root.scheduleAnnotationsWrite()
        root.requestShapePaint()
    }

    function removeDraft() {
        const item = root.findAnnotation(root.draftId)
        if (item !== null) {
            const remaining = []
            for (let index = 0; index < root.annotations.length; index += 1) {
                if (root.annotations[index].id !== item.id) remaining.push(root.annotations[index])
            }
            root.annotations = remaining
        }
        root.drawing = false
        root.draftId = ""
        root.draftAtStart = 0
        root.renumber()
        root.annotations = root.annotations.slice()
        root.writeAnnotations()
        root.requestShapePaint()
    }

    function endDraw(localX, localY) {
        if (!root.drawing) return
        root.updateDraw(localX, localY)
        const item = root.findAnnotation(root.draftId)
        root.drawing = false
        if (item === null) {
            root.draftId = ""
            root.writeAnnotations()
            return
        }
        const dx = item.to[0] - item.from[0]
        const dy = item.to[1] - item.from[1]
        const length = Math.sqrt(dx * dx + dy * dy)
        const tooSmall = item.shape === "arrow"
            ? length < 6 * root.scale
            : Math.abs(dx) < 4 * root.scale || Math.abs(dy) < 4 * root.scale
        if (tooSmall) {
            const clickX = item.to[0]
            const clickY = item.to[1]
            root.removeDraft()
            root.selectAt(clickX, clickY)
            return
        }
        item.atEnd = Date.now()
        const midX = (item.from[0] + item.to[0]) / 2
        const midY = (item.from[1] + item.to[1]) / 2
        const windowId = root.windowAt(root.imageToGlobalX(midX), root.imageToGlobalY(midY))
        item.windowId = windowId
        root.draftId = ""
        root.draftAtStart = 0
        root.renumber()
        root.annotations = root.annotations.slice()
        root.selectedId = item.id
        root.syncCommentEditor()
        root.writeAnnotations()
        root.requestShapePaint()
        root.focusSurface()
    }

    function cancelDraft() {
        if (!root.drawing) return
        root.removeDraft()
        root.focusSurface()
    }

    function deleteSelected() {
        const item = root.selectedAnnotation()
        if (item === null) return
        root.pushUndo()
        const remaining = []
        for (let index = 0; index < root.annotations.length; index += 1) {
            if (root.annotations[index].id !== item.id) remaining.push(root.annotations[index])
        }
        root.annotations = remaining
        root.selectedId = ""
        root.renumber()
        root.annotations = root.annotations.slice()
        root.syncCommentEditor()
        root.writeAnnotations()
        root.requestShapePaint()
        root.focusSurface()
    }

    function undo() {
        if (root.drawing) {
            root.cancelDraft()
            return
        }
        if (root.undoStack.length === 0) return
        const snapshot = root.undoStack[root.undoStack.length - 1]
        root.undoStack = root.undoStack.slice(0, root.undoStack.length - 1)
        const restored = root.parseJson(snapshot)
        root.annotations = Array.isArray(restored) ? restored : []
        root.selectedId = ""
        root.renumber()
        root.annotations = root.annotations.slice()
        root.syncCommentEditor()
        root.writeAnnotations()
        root.requestShapePaint()
        root.focusSurface()
    }

    function clearAnnotations() {
        if (root.annotations.length === 0 && !root.drawing) return
        root.pushUndo()
        root.drawing = false
        root.draftId = ""
        root.annotations = []
        root.selectedId = ""
        root.syncCommentEditor()
        root.writeAnnotations()
        root.requestShapePaint()
        root.focusSurface()
    }

    // -- Canvas painting ----------------------------------------------------
    function paintShapes(context) {
        const width = shapeCanvas.width
        const height = shapeCanvas.height
        context.clearRect(0, 0, width, height)
        if (root.capture === null || width <= 0 || height <= 0) return
        context.lineWidth = 2
        context.lineCap = "round"
        context.lineJoin = "round"
        for (let index = 0; index < root.annotations.length; index += 1) {
            const item = root.annotations[index]
            if (!item.from || !item.to) continue
            const x1 = item.from[0] / root.scale
            const y1 = item.from[1] / root.scale
            const x2 = item.to[0] / root.scale
            const y2 = item.to[1] / root.scale
            let color = "#ff5d5d"
            let lineWidth = 2
            if (root.drawing && item.id === root.draftId) {
                color = "#e0a04c"
                lineWidth = 2
            } else if (item.id === root.selectedId) {
                color = "#7bd88f"
                lineWidth = 3
            }
            context.strokeStyle = color
            context.lineWidth = lineWidth
            if (item.shape === "ellipse") {
                const rx = Math.abs(x2 - x1) / 2
                const ry = Math.abs(y2 - y1) / 2
                if (rx < 0.5 || ry < 0.5) continue
                context.save()
                context.translate((x1 + x2) / 2, (y1 + y2) / 2)
                context.scale(rx, ry)
                context.beginPath()
                context.arc(0, 0, 1, 0, Math.PI * 2)
                context.restore()
                context.stroke()
            } else if (item.shape === "arrow") {
                const dx = x2 - x1
                const dy = y2 - y1
                const length = Math.sqrt(dx * dx + dy * dy)
                if (length < 1) continue
                const ux = dx / length
                const uy = dy / length
                const head = Math.min(18, length * 0.45)
                context.beginPath()
                context.moveTo(x1, y1)
                context.lineTo(x2, y2)
                context.moveTo(x2, y2)
                context.lineTo(x2 - ux * head - uy * head * 0.5, y2 - uy * head + ux * head * 0.5)
                context.moveTo(x2, y2)
                context.lineTo(x2 - ux * head + uy * head * 0.5, y2 - uy * head - ux * head * 0.5)
                context.stroke()
            } else {
                context.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1))
            }
        }
    }

    // -- State transitions --------------------------------------------------
    function focusSurface() {
        Qt.callLater(function() {
            if (root.phase !== "cancelled") surface.forceActiveFocus()
        })
    }

    function showToast(text) {
        root.toast = text
        root.toastAt = Date.now()
    }

    function fail(kind, text, retryable) {
        if (root.finishedEmitted) return
        root.phase = "error"
        root.errorKind = kind
        root.errorText = text
        root.errorRetryable = retryable
        root.confirmCancel = false
        root.focusSurface()
    }

    function parseActiveFile(text) {
        if (root.session !== null) return
        const parsed = root.parseJson(text)
        if (parsed === null || parsed.version !== 1) return
        if (typeof parsed.sessionId !== "string" || parsed.sessionId === "") return
        if (typeof parsed.dir !== "string" || parsed.dir === "") return
        // A leftover pointer from a crashed session must not capture this
        // request: a fresh one was written at or after loadingStartedAt.
        if (typeof parsed.startedAt === "number" && parsed.startedAt > 0
            && parsed.startedAt < root.loadingStartedAt - 60000) return
        if (root.active !== null && root.active.sessionId === parsed.sessionId && root.sessionDir !== "") return
        root.active = parsed
        root.sessionDir = parsed.dir
        if (typeof parsed.startedAt === "number" && parsed.startedAt > 0) root.startedAt = parsed.startedAt
        Qt.callLater(function() {
            if (root.phase === "loading" && root.sessionDir !== "") sessionFile.reload()
        })
    }

    function parseSessionFile(text) {
        if (root.session !== null) return
        const parsed = root.parseJson(text)
        if (parsed === null || parsed.version !== 1) return
        const capture = parsed.capture
        if (!capture || typeof capture.path !== "string" || capture.path === "") return
        if (typeof capture.width !== "number" || capture.width <= 0) return
        if (typeof capture.height !== "number" || capture.height <= 0) return
        if (!Array.isArray(capture.layoutRect) || capture.layoutRect.length < 4) return
        root.session = parsed
        if (typeof parsed.startedAt === "number" && parsed.startedAt > 0) root.startedAt = parsed.startedAt
        if (typeof parsed.language === "string" && (parsed.language === "zh" || parsed.language === "en")) {
            root.language = parsed.language
        }
        root.targetScreen = root.findTargetScreen()
        root.captureUrl = root.fileUrl(capture.path)
        root.annotations = []
        root.voices = []
        root.undoStack = []
        root.annotationCounter = 0
        root.voiceCounter = 0
        root.selectedId = ""
        root.overallNote = ""
        root.errorKind = ""
        root.errorText = ""
        root.phase = "annotating"
        Qt.callLater(function() {
            root.writeAnnotations()
            root.writeVoiceEvents()
            root.focusSurface()
        })
    }

    function retryLoading() {
        root.session = null
        root.active = null
        root.sessionDir = ""
        root.captureUrl = ""
        root.annotations = []
        root.voices = []
        root.phase = "loading"
        root.loadingStartedAt = Date.now()
        root.errorKind = ""
        root.errorText = ""
        root.errorRetryable = false
        if (activeFile.path !== "") activeFile.reload()
    }

    function tickLoading() {
        root.nowMs = Date.now()
        if (root.nowMs - root.loadingStartedAt > root.loadingTimeoutMs) {
            root.fail("load", root.tr("errorLoad"), true)
            return
        }
        if (root.active === null && activeFile.path !== "") activeFile.reload()
        if (root.session === null && root.sessionDir !== "" && sessionFile.path !== "") sessionFile.reload()
    }

    function tickClock() {
        root.nowMs = Date.now()
        if (root.listening && root.nowMs - root.listeningAtStart > root.maxVoiceMs) root.stopVoice()
        if (root.toast !== "" && root.nowMs - root.toastAt > 4000) root.toast = ""
        if (root.phase === "sent" && root.nowMs - root.sentAt >= root.sentCloseMs) root.finishOnce("sent")
        if (root.phase === "sending" && root.nowMs - root.phaseStartedAt > root.sendTimeoutMs) {
            root.fail("send", root.tr("errorTimeout"), true)
        }
        if (root.phase === "sending" && root.nowMs - root.lastAckReload > 300) {
            root.lastAckReload = root.nowMs
            if (ackFile.path !== "") ackFile.reload()
        }
        if (root.hasPendingVoices()) {
            for (let index = 0; index < root.voices.length; index += 1) {
                const voice = root.voices[index]
                if (voice.state === "pending" && root.nowMs - voice.atEnd > root.voiceTimeoutMs) {
                    voice.state = "failed"
                    voice.error = "timeout"
                    root.voices = root.voices.slice()
                    root.syncLiveVoiceEditor()
                    root.showToast(root.tr("voiceFailedToast"))
                }
            }
        }
    }

    function tickVoicePoll() {
        root.pollVoices()
    }

    // -- Review and submission ---------------------------------------------
    function enterReview() {
        if (root.phase !== "annotating" || !root.canReview()) return
        if (root.listening) root.stopVoice()
        root.selectedId = ""
        root.syncCommentEditor()
        root.annotations = root.annotations.slice()
        root.voices = root.voices.slice()
        root.phase = "review"
        root.focusSurface()
    }

    function leaveReview() {
        if (root.phase !== "review") return
        root.phase = "annotating"
        root.syncLiveVoiceEditor()
        root.focusSurface()
    }

    function sendJson() {
        const items = []
        for (let index = 0; index < root.annotations.length; index += 1) {
            items.push(root.annotationPayload(root.annotations[index]))
        }
        const segments = []
        for (let index = 0; index < root.voices.length; index += 1) {
            const voice = root.voices[index]
            const segment = { id: voice.id, text: typeof voice.text === "string" ? voice.text : "" }
            if (voice.bindingMode === "global") segment.annotationId = null
            else if (typeof voice.bindingMode === "string" && voice.bindingMode !== "auto" && voice.bindingMode !== "") {
                segment.annotationId = voice.bindingMode
            }
            segments.push(segment)
        }
        const sessionId = root.session !== null && typeof root.session.sessionId === "string"
            ? root.session.sessionId
            : (root.active !== null && typeof root.active.sessionId === "string" ? root.active.sessionId : "")
        return JSON.stringify({
            version: 1,
            sessionId: sessionId,
            at: Date.now(),
            overallNote: root.overallNote,
            items: items,
            segments: segments
        })
    }

    function submit() {
        if (root.phase !== "review" && root.phase !== "error") return
        if (root.session === null || root.sendPath === "") {
            root.fail("send", root.tr("errorWrite"), false)
            return
        }
        if (!root.canSubmit()) {
            root.showToast(root.tr("transcribing"))
            return
        }
        root.sendStartedAt = Date.now()
        root.errorKind = ""
        root.errorText = ""
        root.errorRetryable = false
        sendFile.path = root.sendPath
        sendFile.setText(root.sendJson())
    }

    function applyAck(text) {
        if (root.phase !== "sending") return
        const parsed = root.parseJson(text)
        if (parsed === null || parsed.version !== 1 || typeof parsed.ok !== "boolean") return
        // Ignore a receipt that predates this attempt; the plugin writes a new
        // at for every send and a retry must not consume the old error.
        if (typeof parsed.at === "number" && parsed.at < root.sendStartedAt - 1000) return
        if (parsed.ok === true) {
            root.phase = "sent"
            root.sentAt = Date.now()
            root.ackMessage = typeof parsed.message === "string" ? parsed.message : ""
            root.focusSurface()
        } else {
            root.fail("send",
                typeof parsed.message === "string" && parsed.message !== "" ? parsed.message : root.tr("errorSend"),
                true)
        }
    }

    function applyErrorFile(text) {
        // While a submission is in flight the ack receipt is authoritative; a
        // plugin error.json would otherwise race it with a non-retryable card.
        if (root.phase === "sent" || root.phase === "cancelled" || root.phase === "sending") return
        const parsed = root.parseJson(text)
        if (parsed === null || parsed.version !== 1 || typeof parsed.message !== "string") return
        if (parsed.message === "") return
        root.fail("plugin", parsed.message, false)
    }

    function errorButtons() {
        if (root.errorKind === "load") {
            return [{ key: "retry", label: root.tr("retry") }, { key: "cancel", label: root.tr("close") }]
        }
        if (root.errorKind === "send") {
            return [
                { key: "retry", label: root.tr("retry") },
                { key: "back", label: root.tr("backToReview") },
                { key: "cancel", label: root.tr("cancel") }
            ]
        }
        if (root.errorKind === "image") {
            return [{ key: "retry", label: root.tr("retry") }, { key: "cancel", label: root.tr("close") }]
        }
        if (root.errorKind === "plugin") {
            return [{ key: "back", label: root.tr("backToReview") }, { key: "cancel", label: root.tr("cancel") }]
        }
        return [{ key: "cancel", label: root.tr("close") }]
    }

    function errorTitle() {
        if (root.errorKind === "load") return root.tr("loadFailed")
        if (root.errorKind === "send") return root.tr("sendFailed")
        return root.tr("errorTitle")
    }

    function retryAfterError() {
        if (root.errorKind === "load") {
            root.retryLoading()
            return
        }
        if (root.errorKind === "image") {
            root.phase = "annotating"
            root.errorKind = ""
            root.errorText = ""
            root.reloadImage()
            return
        }
        if (root.errorKind === "send") {
            root.phase = "review"
            root.submit()
            return
        }
        root.phase = "review"
        root.focusSurface()
    }

    function runErrorAction(key) {
        if (key === "retry") {
            root.retryAfterError()
        } else if (key === "back") {
            root.phase = root.session !== null ? "review" : "annotating"
            root.errorKind = ""
            root.errorText = ""
            root.focusSurface()
        } else {
            root.cancelAnnotate()
        }
    }

    function cancelAnnotate() {
        root.confirmCancel = false
        if (root.sessionDir === "" || root.cancelPath === "") {
            root.finishOnce("cancelled")
            return
        }
        root.cancelRequested = true
        cancelFile.path = root.cancelPath
        cancelFile.setText(JSON.stringify({ version: 1, at: Date.now() }))
        cancelFallbackTimer.restart()
    }

    function finishOnce(outcome) {
        if (root.finishedEmitted) return
        root.finishedEmitted = true
        root.phase = outcome === "sent" ? "sent" : "cancelled"
        root.finished(outcome)
    }

    // Called by shell.qml when the Host disappears, the overlay is asked to
    // quit, or another mode takes over. The cancel file is written synchronously
    // (cancelFile.blockWrites) before the surface is unloaded.
    function abortForHost(reason) {
        if (root.finishedEmitted) return
        if (root.sessionDir !== "" && root.phase !== "sent" && root.phase !== "cancelled") {
            root.cancelRequested = true
            cancelFile.path = root.cancelPath
            cancelFile.setText(JSON.stringify({ version: 1, at: Date.now() }))
        }
        root.finishOnce("cancelled")
    }

    // -- Keyboard -----------------------------------------------------------
    function handleEscape() {
        if (root.confirmCancel) {
            root.cancelAnnotate()
            return
        }
        if (root.listening) {
            root.stopVoice()
            return
        }
        if (root.drawing) {
            root.cancelDraft()
            return
        }
        if (root.phase === "loading") {
            root.finishOnce("cancelled")
        } else if (root.phase === "annotating") {
            root.confirmCancel = true
        } else if (root.phase === "review") {
            root.leaveReview()
        } else if (root.phase === "sent") {
            root.finishOnce("sent")
        } else if (root.phase === "error") {
            if (root.errorKind === "send" || root.errorKind === "plugin") {
                root.phase = "review"
                root.errorKind = ""
                root.errorText = ""
                root.focusSurface()
            } else {
                root.cancelAnnotate()
            }
        }
    }

    function handleKeyPressed(event) {
        if (event.isAutoRepeat) {
            if (event.key === Qt.Key_Space) event.accepted = true
            return
        }
        if (event.key === Qt.Key_Escape) {
            root.handleEscape()
            event.accepted = true
            return
        }
        if (root.confirmCancel) {
            if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                root.confirmCancel = false
                root.focusSurface()
            }
            event.accepted = true
            return
        }
        if (root.phase === "annotating") {
            if (event.key === Qt.Key_Space) {
                root.startVoice()
                event.accepted = true
            } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                root.enterReview()
                event.accepted = true
            } else if (event.key === Qt.Key_Delete || event.key === Qt.Key_Backspace) {
                root.deleteSelected()
                event.accepted = true
            } else if ((event.modifiers & Qt.ControlModifier) && event.key === Qt.Key_Z) {
                root.undo()
                event.accepted = true
            }
            return
        }
        if (root.phase === "review" && (event.key === Qt.Key_Return || event.key === Qt.Key_Enter)) {
            root.submit()
            event.accepted = true
        }
    }

    function handleKeyReleased(event) {
        if (event.isAutoRepeat) {
            if (event.key === Qt.Key_Space) event.accepted = true
            return
        }
        if (event.key === Qt.Key_Space && root.listening) {
            root.stopVoice()
            event.accepted = true
        }
    }

    function reloadImage() {
        const url = root.captureUrl
        captureImage.source = ""
        Qt.callLater(function() { captureImage.source = url })
    }

    // -- Lifecycle ----------------------------------------------------------
    Component.onCompleted: {
        root.language = root.hintLanguage === "en" ? "en" : "zh"
        root.loadingStartedAt = Date.now()
        root.nowMs = Date.now()
        if (root.activePath !== "") activeFile.reload()
    }

    // -- Window -------------------------------------------------------------
    // Hidden until the session is ready: the plugin takes its frozen screenshot
    // after open.json, so a visible surface here would end up in the capture.
    visible: root.phase !== "loading"
    anchors {
        top: true
        left: true
        right: true
        bottom: true
    }
    exclusionMode: ExclusionMode.Ignore
    color: "#8c000000"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: root.visible ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None
    WlrLayershell.namespace: "hyprscope-message-annotate"

    Binding {
        target: root
        property: "screen"
        value: root.targetScreen
        when: root.targetScreen !== null
    }

    // -- Inline button ------------------------------------------------------
    component PillButton: Rectangle {
        id: button
        property string label: ""
        property bool selected: false
        property bool muted: false
        signal clicked()

        width: labelText.implicitWidth + 20
        height: 30
        radius: 8
        color: selected ? "#2f4f9e" : (buttonMouse.containsMouse ? "#23262d" : "transparent")
        border.width: selected ? 0 : 1
        border.color: muted ? "#24272e" : "#2c3038"
        opacity: muted ? 0.55 : 1

        Text {
            id: labelText
            anchors.centerIn: parent
            text: button.label
            color: button.selected ? "#ffffff" : "#e8ebf2"
            font.pixelSize: 12
            font.bold: button.selected
        }

        MouseArea {
            id: buttonMouse
            anchors.fill: parent
            hoverEnabled: true
            enabled: !button.muted
            cursorShape: Qt.PointingHandCursor
            onClicked: button.clicked()
        }
    }

    Item {
        id: surface
        anchors.fill: parent
        focus: true

        Keys.onPressed: function(event) { root.handleKeyPressed(event) }
        Keys.onReleased: function(event) { root.handleKeyReleased(event) }
        onActiveFocusChanged: {
            if (!activeFocus && root.listening) root.stopVoice()
        }

        // Pointer and click tracking over the dark scrim. Clicks on the image
        // are caught by drawArea; a click here deselects the current annotation.
        MouseArea {
            id: backgroundArea
            anchors.fill: parent
            hoverEnabled: true
            onClicked: {
                if (root.phase === "annotating") {
                    root.selectedId = ""
                    root.syncCommentEditor()
                    root.requestShapePaint()
                }
                root.focusSurface()
            }
            onPositionChanged: function(mouse) { root.updatePointer(mouse.x, mouse.y) }
        }

        Image {
            id: captureImage
            x: root.imageX
            y: root.imageY
            width: root.imageW
            height: root.imageH
            source: root.captureUrl
            fillMode: Image.Stretch
            asynchronous: true
            cache: false
            smooth: true
            visible: root.capture !== null
            onStatusChanged: {
                if (status === Image.Ready) {
                    if (root.phase === "error" && root.errorKind === "image") {
                        root.phase = "annotating"
                        root.errorKind = ""
                        root.errorText = ""
                        root.focusSurface()
                    }
                } else if (status === Image.Error && root.capture !== null) {
                    root.fail("image", root.tr("errorImage"), true)
                }
            }
        }

        Canvas {
            id: shapeCanvas
            x: root.imageX
            y: root.imageY
            width: root.imageW
            height: root.imageH
            visible: root.capture !== null
            onPaint: root.paintShapes(getContext("2d"))
            onWidthChanged: requestPaint()
            onHeightChanged: requestPaint()
        }

        Repeater {
            model: root.annotations
            delegate: Rectangle {
                id: badge
                visible: root.capture !== null && !(root.drawing && modelData.id === root.draftId)
                x: Math.max(root.imageX + 2, Math.min(root.imageX + root.imageW - width - 2,
                    root.imageX + modelData.from[0] / root.scale - width / 2))
                y: Math.max(root.imageY + 2, Math.min(root.imageY + root.imageH - height - 2,
                    root.imageY + modelData.from[1] / root.scale - height - 4))
                width: Math.max(20, badgeText.implicitWidth + 10)
                height: 20
                radius: 10
                color: modelData.id === root.selectedId ? "#7bd88f" : "#4b7bec"
                border.width: 1
                border.color: "#0d0f13"

                Text {
                    id: badgeText
                    anchors.centerIn: parent
                    text: modelData.index
                    color: "#0d0f13"
                    font.pixelSize: 11
                    font.bold: true
                }

                MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.selectAnnotation(modelData.id)
                }
            }
        }

        MouseArea {
            id: drawArea
            x: root.imageX
            y: root.imageY
            width: root.imageW
            height: root.imageH
            visible: root.capture !== null
            enabled: root.phase === "annotating"
            hoverEnabled: true
            acceptedButtons: Qt.LeftButton
            cursorShape: root.phase === "annotating" && root.tool === "select"
                ? Qt.ArrowCursor : Qt.CrossCursor
            onPressed: {
                root.updatePointer(root.imageX + mouse.x, root.imageY + mouse.y)
                root.beginDraw(mouse.x, mouse.y)
                root.focusSurface()
            }
            onPositionChanged: function(mouse) {
                root.updatePointer(root.imageX + mouse.x, root.imageY + mouse.y)
                if (root.drawing) root.updateDraw(mouse.x, mouse.y)
            }
            onReleased: {
                if (root.drawing) root.endDraw(mouse.x, mouse.y)
            }
        }

        // -- Toolbar --------------------------------------------------------
        Rectangle {
            id: toolbar
            z: 10
            visible: root.phase === "annotating"
            anchors.horizontalCenter: parent.horizontalCenter
            y: parent.height - height - 24
            width: toolRow.implicitWidth + 28
            height: 46
            radius: 23
            color: "#e614161b"
            border.width: 1
            border.color: "#2c3038"

            MouseArea {
                anchors.fill: parent
                onClicked: root.focusSurface()
            }

            Row {
                id: toolRow
                anchors.centerIn: parent
                spacing: 4

                Repeater {
                    model: root.toolItems()
                    delegate: PillButton {
                        label: modelData.label
                        selected: root.tool === modelData.key
                        onClicked: {
                            root.tool = modelData.key
                            root.focusSurface()
                        }
                    }
                }

                Rectangle {
                    width: 1
                    height: 18
                    color: "#2c3038"
                }

                Repeater {
                    model: root.actionItems()
                    delegate: PillButton {
                        label: modelData.label
                        muted: modelData.enabled === false
                        onClicked: {
                            if (modelData.key === "undo") root.undo()
                            else if (modelData.key === "clear") root.clearAnnotations()
                            else if (modelData.key === "cancel") root.confirmCancel = true
                            else if (modelData.key === "review") root.enterReview()
                        }
                    }
                }
            }
        }

        Text {
            z: 10
            visible: root.phase === "annotating"
            anchors.horizontalCenter: parent.horizontalCenter
            y: toolbar.y - height - 10
            text: root.tr("annotateHint")
            color: "#8b93a3"
            font.pixelSize: 12
        }

        // -- Listening banner ----------------------------------------------
        Rectangle {
            id: listeningBanner
            z: 11
            visible: root.listening
            anchors.horizontalCenter: parent.horizontalCenter
            y: toolbar.y - height - 34
            width: listeningLabel.implicitWidth + 28
            height: 34
            radius: 17
            color: "#e6a1272a"
            border.width: 1
            border.color: "#e05d5d"

            Text {
                id: listeningLabel
                anchors.centerIn: parent
                textFormat: Text.RichText
                text: '<font color="#ff6b6b">&#9679;</font>&nbsp;&nbsp;' + root.listeningText()
                color: "#ffd7d7"
                font.pixelSize: 12
            }
        }

        // -- Comment editor -------------------------------------------------
        Rectangle {
            id: commentCard
            z: 12
            visible: root.phase === "annotating" && root.selectedId !== "" && !root.confirmCancel
            x: 24
            y: Math.max(24, parent.height - height - 100)
            width: 360
            height: 170
            radius: 12
            color: "#e614161b"
            border.width: 1
            border.color: "#2c3038"

            MouseArea {
                anchors.fill: parent
                onClicked: root.focusSurface()
            }

            Column {
                x: 16
                y: 14
                width: parent.width - 32
                spacing: 8

                Text {
                    width: parent.width
                    text: root.commentTitle()
                    color: "#f2f4f8"
                    font.pixelSize: 13
                    font.bold: true
                }

                Rectangle {
                    width: parent.width
                    height: 82
                    radius: 8
                    color: "#0d0f13"
                    border.width: 1
                    border.color: commentInput.activeFocus ? "#4b7bec" : "#2c3038"

                    TextEdit {
                        id: commentInput
                        anchors.fill: parent
                        anchors.margins: 8
                        color: "#f2f4f8"
                        font.pixelSize: 13
                        wrapMode: TextEdit.WordWrap
                        selectByMouse: true
                        clip: true
                        onTextChanged: {
                            if (root.commentSync) return
                            const item = root.selectedAnnotation()
                            if (item === null) return
                            item.comment = text
                            root.scheduleAnnotationsWrite()
                        }
                        Keys.onEscapePressed: function(event) {
                            root.focusSurface()
                            event.accepted = true
                        }
                    }

                    Text {
                        anchors.left: parent.left
                        anchors.top: parent.top
                        anchors.margins: 12
                        visible: commentInput.text === "" && !commentInput.activeFocus
                        text: root.tr("commentPlaceholder")
                        color: "#5d6472"
                        font.pixelSize: 13
                    }
                }

                Row {
                    spacing: 8

                    PillButton {
                        label: root.tr("delete")
                        onClicked: root.deleteSelected()
                    }

                    PillButton {
                        label: root.tr("done")
                        onClicked: root.focusSurface()
                    }
                }
            }
        }

        // -- Live voice card (annotating mode) ------------------------------
        // Shows the last push-to-talk segment right after Space is released, so
        // the transcript can be corrected without opening the review card first.
        Rectangle {
            id: liveVoiceCard
            z: 12
            visible: root.phase === "annotating" && !root.listening && root.lastVoice() !== null
            anchors.right: parent.right
            anchors.rightMargin: 24
            y: toolbar.y - height - 10
            width: 380
            height: 150
            radius: 12
            color: "#e614161b"
            border.width: 1
            border.color: "#2c3038"

            MouseArea {
                anchors.fill: parent
                onClicked: root.focusSurface()
            }

            Column {
                x: 14
                y: 12
                width: parent.width - 28
                spacing: 6

                Row {
                    spacing: 8

                    Text {
                        text: root.liveVoiceIdText()
                        color: "#4b7bec"
                        font.pixelSize: 12
                        font.bold: true
                    }

                    Text {
                        text: root.liveVoiceStatusText()
                        color: root.liveVoiceStatusColor()
                        font.pixelSize: 11
                    }
                }

                Rectangle {
                    width: parent.width
                    height: 76
                    radius: 8
                    color: "#0d0f13"
                    border.width: 1
                    border.color: liveVoiceInput.activeFocus ? "#4b7bec" : "#2c3038"

                    TextEdit {
                        id: liveVoiceInput
                        anchors.fill: parent
                        anchors.margins: 8
                        color: "#e8ebf2"
                        font.pixelSize: 13
                        wrapMode: TextEdit.WordWrap
                        selectByMouse: true
                        clip: true
                        onTextChanged: {
                            if (root.liveVoiceSync) return
                            const voice = root.findVoice(root.liveVoiceId)
                            if (voice === null) return
                            voice.text = text
                            voice.edited = true
                        }
                        Keys.onEscapePressed: function(event) {
                            root.focusSurface()
                            event.accepted = true
                        }
                    }

                    Text {
                        anchors.left: parent.left
                        anchors.top: parent.top
                        anchors.margins: 12
                        visible: liveVoiceInput.text === "" && !liveVoiceInput.activeFocus
                        text: root.tr("liveVoicePlaceholder")
                        color: "#5d6472"
                        font.pixelSize: 13
                    }
                }

                Text {
                    width: parent.width
                    text: root.liveVoiceFailed() ? root.tr("transcriptionFailed") : root.tr("liveVoiceHint")
                    color: root.liveVoiceFailed() ? "#e0a04c" : "#6f7684"
                    font.pixelSize: 11
                    wrapMode: Text.WordWrap
                }
            }
        }

        // -- Toast ----------------------------------------------------------
        Rectangle {
            id: toastCard
            z: 13
            visible: root.toast !== ""
            anchors.horizontalCenter: parent.horizontalCenter
            y: toolbar.y - height - 78
            width: toastText.implicitWidth + 28
            height: 32
            radius: 16
            color: "#e6a1272a"
            border.width: 1
            border.color: "#e0a04c"

            Text {
                id: toastText
                anchors.centerIn: parent
                text: root.toast
                color: "#ffd7a8"
                font.pixelSize: 12
            }
        }

        // -- Review / sending / sent card -----------------------------------
        Rectangle {
            id: reviewCard
            z: 20
            visible: root.phase === "review" || root.phase === "sending" || root.phase === "sent"
            anchors.centerIn: parent
            width: Math.min(800, root.width - 80)
            height: root.phase === "review" ? Math.min(720, root.height - 120) : 300
            radius: 16
            color: "#14161b"
            border.width: 1
            border.color: "#2c3038"

            MouseArea {
                anchors.fill: parent
                onClicked: root.focusSurface()
            }

            Column {
                id: reviewHeader
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.margins: 24
                spacing: 6

                Text {
                    width: parent.width
                    text: root.phase === "sending" ? root.tr("sendingTitle")
                        : root.phase === "sent" ? root.tr("sentTitle") : root.tr("reviewTitle")
                    color: "#f2f4f8"
                    font.pixelSize: 19
                    font.bold: true
                }

                Text {
                    width: parent.width
                    visible: root.phase === "review"
                    text: root.fmt("reviewSubtitle", { n: root.annotations.length, m: root.voices.length })
                    color: "#8b93a3"
                    font.pixelSize: 12
                }
            }

            Item {
                id: statusPane
                visible: root.phase !== "review"
                anchors.fill: parent

                Column {
                    anchors.centerIn: parent
                    width: Math.min(reviewCard.width - 80, 520)
                    spacing: 14

                    Item {
                        width: parent.width
                        height: 28
                        visible: root.phase === "sending"

                        Item {
                            id: spinner
                            width: 28
                            height: 28
                            anchors.centerIn: parent

                            Rectangle {
                                anchors.fill: parent
                                radius: 14
                                color: "transparent"
                                border.width: 3
                                border.color: "#2c3038"
                            }

                            Rectangle {
                                width: 6
                                height: 6
                                radius: 3
                                color: "#4b7bec"
                                x: parent.width / 2 - 3
                                y: 0
                            }

                            RotationAnimator {
                                target: spinner
                                from: 0
                                to: 360
                                duration: 900
                                loops: Animation.Infinite
                                running: root.phase === "sending"
                            }
                        }
                    }

                    Text {
                        width: parent.width
                        visible: root.phase === "sent"
                        text: "✓"
                        color: "#7bd88f"
                        font.pixelSize: 34
                        font.bold: true
                        horizontalAlignment: Text.AlignHCenter
                    }

                    Text {
                        visible: root.phase === "sending"
                        text: root.tr("sendingBody")
                        color: "#c7ccd6"
                        font.pixelSize: 13
                        wrapMode: Text.WordWrap
                        width: parent.width
                        horizontalAlignment: Text.AlignHCenter
                    }

                    Text {
                        visible: root.phase === "sent"
                        text: root.ackMessage !== "" ? root.ackMessage : root.tr("sentClosing")
                        color: "#8b93a3"
                        font.pixelSize: 13
                        wrapMode: Text.WordWrap
                        width: parent.width
                        horizontalAlignment: Text.AlignHCenter
                    }
                }
            }

            Flickable {
                id: reviewFlick
                visible: root.phase === "review"
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: reviewHeader.bottom
                anchors.bottom: reviewFooter.top
                anchors.leftMargin: 24
                anchors.rightMargin: 24
                anchors.topMargin: 18
                anchors.bottomMargin: 16
                contentHeight: reviewColumn.height
                clip: true

                Column {
                    id: reviewColumn
                    width: reviewFlick.width
                    spacing: 10

                    Text {
                        width: parent.width
                        text: root.tr("sectionAnnotations")
                        color: "#8b93a3"
                        font.pixelSize: 12
                        font.bold: true
                    }

                    Repeater {
                        model: root.annotations
                        delegate: Rectangle {
                            width: reviewColumn.width
                            height: annotationColumn.implicitHeight + 20
                            radius: 9
                            color: "#0d0f13"
                            border.width: 1
                            border.color: "#2c3038"

                            Column {
                                id: annotationColumn
                                x: 12
                                y: 10
                                width: parent.width - 24
                                spacing: 6

                                Row {
                                    spacing: 8

                                    Text {
                                        text: "#" + modelData.index
                                        color: "#4b7bec"
                                        font.pixelSize: 12
                                        font.bold: true
                                    }

                                    Text {
                                        text: root.shapeLabel(modelData.shape)
                                        color: "#9aa3b2"
                                        font.pixelSize: 12
                                    }

                                    Text {
                                        text: root.timeRange(modelData.atStart, modelData.atEnd)
                                        color: "#6f7684"
                                        font.pixelSize: 11
                                    }
                                }

                                TextEdit {
                                    width: parent.width
                                    height: Math.max(24, contentHeight)
                                    color: "#e8ebf2"
                                    font.pixelSize: 13
                                    wrapMode: TextEdit.WordWrap
                                    selectByMouse: true
                                    activeFocusOnPress: true
                                    Component.onCompleted: text = modelData.comment || ""
                                    onTextChanged: {
                                        if (modelData === undefined) return
                                        modelData.comment = text
                                        root.scheduleAnnotationsWrite()
                                    }
                                    Keys.onEscapePressed: function(event) {
                                        root.handleEscape()
                                        event.accepted = true
                                    }
                                    Keys.onPressed: function(event) {
                                        if ((event.modifiers & Qt.ControlModifier)
                                            && (event.key === Qt.Key_Return || event.key === Qt.Key_Enter)) {
                                            root.submit()
                                            event.accepted = true
                                        }
                                    }
                                }
                            }
                        }
                    }

                    Text {
                        width: parent.width
                        visible: root.annotations.length === 0
                        text: root.tr("noAnnotations")
                        color: "#6f7684"
                        font.pixelSize: 12
                        wrapMode: Text.WordWrap
                    }

                    Text {
                        width: parent.width
                        text: root.tr("sectionVoices")
                        color: "#8b93a3"
                        font.pixelSize: 12
                        font.bold: true
                    }

                    Repeater {
                        model: root.voices
                        delegate: Rectangle {
                            id: voiceCard
                            property var voiceData: modelData
                            width: reviewColumn.width
                            height: voiceColumn.implicitHeight + 20
                            radius: 9
                            color: "#0d0f13"
                            border.width: 1
                            border.color: "#2c3038"

                            Column {
                                id: voiceColumn
                                x: 12
                                y: 10
                                width: parent.width - 24
                                spacing: 6

                                Row {
                                    spacing: 8

                                    Text {
                                        text: voiceCard.voiceData.id
                                        color: "#4b7bec"
                                        font.pixelSize: 12
                                        font.bold: true
                                    }

                                    Text {
                                        text: root.timeRange(voiceCard.voiceData.atStart, voiceCard.voiceData.atEnd)
                                        color: "#6f7684"
                                        font.pixelSize: 11
                                    }

                                    Text {
                                        text: root.voiceStatus(voiceCard.voiceData)
                                        color: root.voiceStatusColor(voiceCard.voiceData)
                                        font.pixelSize: 11
                                    }
                                }

                                TextEdit {
                                    property bool loadingText: true
                                    width: parent.width
                                    height: Math.max(24, contentHeight)
                                    color: "#e8ebf2"
                                    font.pixelSize: 13
                                    wrapMode: TextEdit.WordWrap
                                    selectByMouse: true
                                    activeFocusOnPress: true
                                    Component.onCompleted: {
                                        text = voiceCard.voiceData.text || ""
                                        loadingText = false
                                    }
                                    onTextChanged: {
                                        if (loadingText) return
                                        if (voiceCard.voiceData === undefined) return
                                        voiceCard.voiceData.text = text
                                        voiceCard.voiceData.edited = true
                                    }
                                    Keys.onEscapePressed: function(event) {
                                        root.handleEscape()
                                        event.accepted = true
                                    }
                                    Keys.onPressed: function(event) {
                                        if ((event.modifiers & Qt.ControlModifier)
                                            && (event.key === Qt.Key_Return || event.key === Qt.Key_Enter)) {
                                            root.submit()
                                            event.accepted = true
                                        }
                                    }
                                }

                                Text {
                                    width: parent.width
                                    visible: voiceCard.voiceData.state === "failed"
                                    text: root.tr("transcriptionFailed")
                                    color: "#e0a04c"
                                    font.pixelSize: 11
                                    wrapMode: Text.WordWrap
                                }

                                Flow {
                                    width: parent.width
                                    height: implicitHeight
                                    spacing: 6

                                    Text {
                                        height: 30
                                        verticalAlignment: Text.AlignVCenter
                                        text: root.tr("bindLabel")
                                        color: "#6f7684"
                                        font.pixelSize: 11
                                    }

                                    Repeater {
                                        model: root.bindingOptions()
                                        delegate: PillButton {
                                            property string optionId: modelData.id
                                            label: modelData.label
                                            selected: root.voiceBindingMatches(voiceCard.voiceData, modelData.id)
                                            onClicked: root.setVoiceBinding(voiceCard.voiceData.id, modelData.id)
                                        }
                                    }
                                }
                            }
                        }
                    }

                    Text {
                        width: parent.width
                        visible: root.voices.length === 0
                        text: root.tr("noVoices")
                        color: "#6f7684"
                        font.pixelSize: 12
                        wrapMode: Text.WordWrap
                    }

                    Text {
                        width: parent.width
                        text: root.tr("sectionNote")
                        color: "#8b93a3"
                        font.pixelSize: 12
                        font.bold: true
                    }

                    Rectangle {
                        width: parent.width
                        height: 74
                        radius: 9
                        color: "#0d0f13"
                        border.width: 1
                        border.color: "#2c3038"

                        TextEdit {
                            id: overallNoteEdit
                            anchors.fill: parent
                            anchors.margins: 10
                            color: "#e8ebf2"
                            font.pixelSize: 13
                            wrapMode: TextEdit.WordWrap
                            selectByMouse: true
                            clip: true
                            Component.onCompleted: text = root.overallNote
                            onTextChanged: root.overallNote = text
                            Keys.onEscapePressed: function(event) {
                                root.handleEscape()
                                event.accepted = true
                            }
                        }

                        Text {
                            anchors.left: parent.left
                            anchors.top: parent.top
                            anchors.margins: 14
                            visible: overallNoteEdit.text === "" && !overallNoteEdit.activeFocus
                            text: root.tr("overallPlaceholder")
                            color: "#5d6472"
                            font.pixelSize: 13
                        }
                    }
                }
            }

            Text {
                id: reviewFooterHint
                visible: root.phase === "review"
                anchors.left: parent.left
                anchors.bottom: parent.bottom
                anchors.leftMargin: 24
                anchors.bottomMargin: 27
                text: root.canSubmit() ? root.tr("reviewHint") : root.tr("transcribing")
                color: root.canSubmit() ? "#6f7684" : "#e0a04c"
                font.pixelSize: 11
            }

            Row {
                id: reviewFooter
                visible: root.phase === "review"
                anchors.right: parent.right
                anchors.bottom: parent.bottom
                anchors.rightMargin: 24
                anchors.bottomMargin: 18
                height: 30
                spacing: 8

                PillButton {
                    label: root.tr("reviewBack")
                    onClicked: root.leaveReview()
                }

                PillButton {
                    label: root.tr("cancel")
                    onClicked: root.confirmCancel = true
                }

                PillButton {
                    label: root.tr("reviewSend")
                    selected: true
                    muted: !root.canSubmit()
                    onClicked: root.submit()
                }
            }
        }

        // -- Error card -----------------------------------------------------
        Rectangle {
            id: errorCard
            z: 25
            visible: root.phase === "error"
            anchors.centerIn: parent
            width: 500
            height: errorColumn.implicitHeight + 48
            radius: 16
            color: "#14161b"
            border.width: 1
            border.color: "#2c3038"

            MouseArea {
                anchors.fill: parent
                onClicked: root.focusSurface()
            }

            Column {
                id: errorColumn
                x: 24
                y: 22
                width: parent.width - 48
                spacing: 12

                Text {
                    width: parent.width
                    text: root.errorTitle()
                    color: "#f2f4f8"
                    font.pixelSize: 18
                    font.bold: true
                }

                Text {
                    width: parent.width
                    text: root.errorText
                    color: "#c7ccd6"
                    font.pixelSize: 13
                    wrapMode: Text.WordWrap
                }

                Row {
                    spacing: 8

                    Repeater {
                        model: root.errorButtons()
                        delegate: PillButton {
                            label: modelData.label
                            onClicked: root.runErrorAction(modelData.key)
                        }
                    }
                }
            }
        }

        // -- Cancel confirmation --------------------------------------------
        Rectangle {
            id: confirmScrim
            z: 30
            visible: root.confirmCancel
            anchors.fill: parent
            color: "#66000000"

            MouseArea {
                anchors.fill: parent
                onClicked: {
                    root.confirmCancel = false
                    root.focusSurface()
                }
            }
        }

        Rectangle {
            id: confirmCard
            z: 31
            visible: root.confirmCancel
            anchors.centerIn: parent
            width: 440
            height: confirmColumn.implicitHeight + 44
            radius: 16
            color: "#14161b"
            border.width: 1
            border.color: "#2c3038"

            MouseArea {
                anchors.fill: parent
                onClicked: {}
            }

            Column {
                id: confirmColumn
                x: 22
                y: 20
                width: parent.width - 44
                spacing: 12

                Text {
                    width: parent.width
                    text: root.tr("confirmCancelTitle")
                    color: "#f2f4f8"
                    font.pixelSize: 17
                    font.bold: true
                }

                Text {
                    width: parent.width
                    text: root.tr("confirmCancelBody")
                    color: "#c7ccd6"
                    font.pixelSize: 13
                    wrapMode: Text.WordWrap
                }

                Row {
                    spacing: 8

                    PillButton {
                        label: root.tr("keepEditing")
                        onClicked: {
                            root.confirmCancel = false
                            root.focusSurface()
                        }
                    }

                    PillButton {
                        label: root.tr("discard")
                        onClicked: root.cancelAnnotate()
                    }
                }
            }
        }
    }

    // -- Files: plugin -> overlay -------------------------------------------
    FileView {
        id: activeFile
        path: root.activePath
        watchChanges: true
        printErrors: false
        onLoaded: root.parseActiveFile(text())
        onFileChanged: reload()
    }

    FileView {
        id: sessionFile
        path: root.sessionPath
        watchChanges: true
        printErrors: false
        onLoaded: root.parseSessionFile(text())
        onFileChanged: reload()
    }

    FileView {
        id: ackFile
        path: root.ackPath
        watchChanges: true
        printErrors: false
        onLoaded: root.applyAck(text())
        onFileChanged: reload()
    }

    FileView {
        id: errorFile
        path: root.errorPath
        watchChanges: true
        printErrors: false
        onLoaded: root.applyErrorFile(text())
        onFileChanged: reload()
    }

    // -- Files: overlay -> plugin -------------------------------------------
    FileView {
        id: annotationsFile
        path: root.annotationsPath
        atomicWrites: true
        printErrors: false
        onSaveFailed: function(error) { root.showToast(root.tr("writeFailedToast")) }
    }

    FileView {
        id: voiceEventsFile
        path: root.voiceEventsPath
        atomicWrites: true
        printErrors: false
        onSaveFailed: function(error) { root.showToast(root.tr("writeFailedToast")) }
    }

    FileView {
        id: sendFile
        path: root.sendPath
        atomicWrites: true
        printErrors: false
        onSaved: root.onSendSaved()
        onSaveFailed: function(error) { root.onSendSaveFailed() }
    }

    FileView {
        id: cancelFile
        path: root.cancelPath
        atomicWrites: true
        blockWrites: true
        printErrors: false
        onSaved: {
            if (root.cancelRequested) root.finishOnce("cancelled")
        }
        onSaveFailed: function(error) {
            if (root.cancelRequested) root.finishOnce("cancelled")
        }
    }

    Component {
        id: voiceFileComponent
        FileView {
            watchChanges: true
            printErrors: false
            onLoaded: root.applyVoiceFile(objectName, text())
            onFileChanged: reload()
        }
    }

    function onSendSaved() {
        if (root.finishedEmitted) return
        root.phase = "sending"
        root.phaseStartedAt = Date.now()
        root.lastAckReload = 0
        root.focusSurface()
    }

    function onSendSaveFailed() {
        root.fail("send", root.tr("errorWrite"), true)
    }

    // -- Timers -------------------------------------------------------------
    Timer {
        id: loadingTimer
        interval: 100
        repeat: true
        running: root.phase === "loading"
        onTriggered: root.tickLoading()
    }

    Timer {
        id: clockTimer
        interval: 150
        repeat: true
        running: true
        onTriggered: root.tickClock()
    }

    Timer {
        id: voicePollTimer
        interval: 400
        repeat: true
        running: root.hasPendingVoices()
        onTriggered: root.tickVoicePoll()
    }

    Timer {
        id: annotationWriteTimer
        interval: 180
        repeat: false
        onTriggered: root.writeAnnotations()
    }

    Timer {
        id: cancelFallbackTimer
        interval: 500
        repeat: false
        onTriggered: root.finishOnce("cancelled")
    }
}
