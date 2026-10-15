import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

@main
struct NoteToSelfApp: App {
    @StateObject private var identity: IdentityModel
    @StateObject private var notes: NoteStore
    init() {
        let identity = IdentityModel()
        _identity = StateObject(wrappedValue:identity)
        _notes = StateObject(wrappedValue:NoteStore(identity:identity))
    }
    var body: some Scene { WindowGroup { NotesHome(notes:notes,identity:identity) } }
}
struct NotesHome: View {
    @ObservedObject var notes: NoteStore
    @ObservedObject var identity: IdentityModel
    @Environment(\.scenePhase) var phase
    @State private var tab = 0
    @State private var settings = false
    @State private var unlock = false
    @State private var picker: PhotosPickerItem?
    @State private var importer = false
    var body: some View {
        TabView(selection:$tab) {
            NavigationStack {
                ScrollView {
                    VStack(alignment:.leading,spacing:16) {
                        Text(notes.connection.map { "Private · " + $0.label } ?? "Connect to nStack to keep your notes available in Flight Deck.").foregroundStyle(.secondary)
                        if notes.draft.thread != nil {
                            HStack { Text("Replying in your note’s thread"); Spacer(); Button("Cancel") { notes.cancelReply() }.disabled(notes.busy || notes.draft.frozen) }
                        }
                        TextEditor(text:Binding(get:{ notes.draft.text },set:{ notes.edit($0) }))
                            .frame(minHeight:220).overlay(RoundedRectangle(cornerRadius:8).stroke(.secondary.opacity(0.4)))
                            .disabled(notes.busy || notes.draft.frozen).accessibilityLabel("Note text")
                        ForEach(notes.draft.images) { image in
                            if let preview = UIImage(data:image.bytes) { Image(uiImage:preview).resizable().scaledToFit().frame(maxHeight:180) }
                            Button("Remove image",role:.destructive) { notes.removeImage(image.id) }.disabled(notes.busy || notes.draft.frozen)
                        }
                        HStack {
                            PhotosPicker(selection:$picker,matching:.images) { Label("Photo",systemImage:"photo") }
                            Button { importer = true } label: { Label("File",systemImage:"folder") }
                            Button("Paste image") { pasteImage() }
                        }.disabled(notes.busy || notes.draft.frozen)
                        if notes.draft.frozen { Text("This submission is saved for retry with the same message ID. Its text and images stay fixed until delivery is confirmed.").font(.footnote).foregroundStyle(.secondary) }
                        Button { Task { await notes.send(); await notes.history() } } label: { Label(notes.draft.frozen ? "Retry send" : "Send to myself",systemImage:"paperplane.fill").frame(maxWidth:.infinity) }
                            .buttonStyle(.borderedProminent).disabled(notes.busy || !notes.storageReady || !identity.unlocked || notes.connection == nil || (notes.draft.text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && notes.draft.images.isEmpty))
                        if !identity.unlocked { Button("Set up or unlock identity") { if identity.exists { unlock = true } else { settings = true } } }
                        if notes.busy { ProgressView("Saving your note…") }
                        if let notice = notes.notice { Text(notice).font(.footnote).textSelection(.enabled) }
                        Text("Known tracking parameters are removed from links. Signed links and functional parameters stay intact. Still images are re-encoded without source metadata before upload.").font(.footnote).foregroundStyle(.secondary)
                    }.padding()
                }.navigationTitle("Note to self").toolbar { Button("Settings") { settings = true } }
            }.tabItem { Label("Compose",systemImage:"square.and.pencil") }.tag(0)
            NavigationStack {
                List {
                    if !identity.unlocked { Button("Unlock to read shared history") { settings = true } }
                    else {
                        if notes.messages.isEmpty { Text("Your shared Flight Deck history will appear here.").foregroundStyle(.secondary) }
                        ForEach(notes.messages) { message in
                            VStack(alignment:.leading,spacing:10) {
                                if message.parent != nil { Text("Reply in note thread").font(.caption).foregroundStyle(.secondary) }
                                Text(.init(message.body)).textSelection(.enabled)
                                ForEach(message.images,id:\.self) { object in PrivateImage(notes:notes,identity:identity,object:object) }
                                Text(message.created).font(.caption).foregroundStyle(.secondary)
                                Button("Reply") { notes.reply(message); tab = 0 }.disabled(notes.busy || notes.draft.frozen)
                            }.padding(.vertical,6)
                        }
                    }
                    if let notice = notes.notice { Text(notice).font(.footnote) }
                }.navigationTitle("History").refreshable { await notes.history() }
                    .toolbar { Button("Refresh") { Task { await notes.history() } }; Button("Settings") { settings = true } }
            }.tabItem { Label("History",systemImage:"clock") }.tag(1)
        }
        .sheet(isPresented:$settings) { NavigationStack { ConnectionSettings(notes:notes,identity:identity).toolbar { Button("Done") { settings = false } } } }
        .sheet(isPresented:$unlock) { IdentityUnlock(model:identity) { unlock = false } }
        .onChange(of:picker) { _,value in
            Task { do { if let data = try await value?.loadTransferable(type:Data.self) { await notes.addImage(data) } } catch { notes.notice = error.localizedDescription }; picker = nil }
        }
        .fileImporter(isPresented:$importer,allowedContentTypes:[.image]) { result in
            Task { do { let url = try result.get(); let access = url.startAccessingSecurityScopedResource(); defer { if access { url.stopAccessingSecurityScopedResource() } }; await notes.addImage(try Data(contentsOf:url)) } catch { notes.notice = error.localizedDescription } }
        }
        .task(id:identity.npub) {
            guard identity.unlocked else { notes.messages = []; if identity.exists { unlock = true }; return }
            while !Task.isCancelled {
                if phase == .active { await notes.history() }
                try? await Task.sleep(for:.seconds(5))
            }
        }
    }
    func pasteImage() {
        let board = UIPasteboard.general
        if let bytes = board.data(forPasteboardType:UTType.png.identifier) ?? board.data(forPasteboardType:UTType.jpeg.identifier) ?? board.image?.pngData() { Task { await notes.addImage(bytes) } }
        else { notes.notice = "Copy an image first, then tap Paste image." }
    }
}
struct PrivateImage: View {
    @ObservedObject var notes: NoteStore
    @ObservedObject var identity: IdentityModel
    let object: String
    @State private var image: UIImage?
    @State private var failed = false
    var body: some View {
        Group {
            if let image { Image(uiImage:image).resizable().scaledToFit().frame(maxHeight:320).accessibilityLabel("Note image") }
            else if failed { Text("Image unavailable. Refresh after checking your connection.").font(.footnote) }
            else { ProgressView() }
        }.task(id:identity.npub) {
            guard let destination = notes.connection, identity.npub == destination.signer else { image = nil; return }
            do {
                let bytes = try await notes.api.image(origin:destination.origin,object:object)
                guard identity.npub == destination.signer else { return }
                image = UIImage(data:bytes); failed = image == nil
            } catch { failed = true }
        }
    }
}
struct ConnectionSettings: View {
    @ObservedObject var notes: NoteStore
    @ObservedObject var identity: IdentityModel
    @State private var origin = ""
    @State private var choices: [[String:Any]] = []
    @State private var loading = false
    var body: some View {
        Form {
            Section("Secure identity") { NavigationLink("Identity and PIN") { IdentitySettings(model:identity) }; Text(identity.npub ?? "Unlock this app’s own identity. Existing app identities remain separate.").font(.footnote).textSelection(.enabled) }
            Section("nStack") {
                TextField("https://your-nstack.example",text:$origin).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("Discover my workspaces") { discover() }.disabled(!identity.unlocked || loading || notes.busy || notes.draft.frozen)
                ForEach(Array(choices.enumerated()),id:\.offset) { _,workspace in
                    Button(workspace["label"] as? String ?? "Workspace") { Task { await notes.connect(origin:origin,workspace:workspace); await notes.history() } }.disabled(notes.busy)
                }
                if loading { ProgressView() }
                if let connection = notes.connection { Text("Connected: " + connection.label).font(.footnote) }
                if let notice = notes.notice { Text(notice).font(.footnote) }
                Text("Selecting a workspace opens or reuses your private self conversation. Use the same identity and workspace as Flight Deck. No other app’s identity is read.").font(.footnote)
            }
        }.navigationTitle("Settings").onAppear { origin = notes.connection?.origin ?? "" }.onChange(of:origin) { _,_ in choices = [] }
    }
    func discover() {
        loading = true; choices = []
        let requested = origin; let signer = identity.npub
        Task {
            defer { loading = false }
            do { let rows = try await notes.discover(origin:requested); guard origin == requested, signer == identity.npub else { return }; choices = rows }
            catch { notes.notice = error.localizedDescription }
        }
    }
}
