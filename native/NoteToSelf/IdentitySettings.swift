// Adapted from In Dialogue Recorder secure native setup.
import SwiftUI

struct IdentitySettings: View {
    @ObservedObject var model: IdentityModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var nsec = ""
    @State private var pin = ""
    @State private var confirmPIN = ""
    @State private var remove = false
    @State private var mismatch = false
    private func clear() { nsec = ""; pin = ""; confirmPIN = "" }
    var body: some View {
        Form {
            Section("Identity") {
                Text(model.exists ? (model.unlocked ? "Imported identity · unlocked" : "Imported identity · locked") : "No imported identity")
                Text("Stored locally using your PIN and this app’s Keychain secret. No connection or upload. Keep your own backup of the nsec.").font(.footnote)
                if model.exists {
                    if model.unlocked { Button("Lock") { model.lock(); clear() } }
                    else {
                        SecureField("PIN", text: $pin).keyboardType(.numberPad)
                        Button("Unlock") { model.perform { try $0.unlock(pin: pin) }; clear() }
                    }
                    Button("Remove identity…", role: .destructive) { remove = true }
                } else {
                    SecureField("Paste nsec", text: $nsec).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Create PIN (4–12 digits)", text: $pin).keyboardType(.numberPad)
                    SecureField("Confirm PIN", text: $confirmPIN).keyboardType(.numberPad)
                    Button("Import identity") {
                        guard pin == confirmPIN else { mismatch = true; clear(); return }
                        model.perform { try $0.create(nsec: nsec, pin: pin) }; clear()
                    }
                }
            }
            if let notice = model.notice { Text(notice) }
        }.navigationTitle("Identity")
            .confirmationDialog("Remove imported identity? Keep a backup before removing. Drafts and deliveries will be retained. Importing a replacement requires this explicit removal.", isPresented: $remove, titleVisibility: .visible) {
                Button("Remove identity", role: .destructive) { model.perform { try $0.remove() }; clear() }
            }
            .alert("PINs do not match", isPresented: $mismatch) { Button("OK", role: .cancel) {} }
            .onChange(of: scenePhase) { _, phase in if phase != .active { clear() } }
            .onDisappear { clear() }
    }
}


struct IdentityUnlock: View {
    @ObservedObject var model: IdentityModel
    let done: () -> Void
    @Environment(\.scenePhase) private var scenePhase
    @State private var pin = ""
    @FocusState private var pinFocused: Bool
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Unlock your identity to send notes. You can keep typing while locked.")
                    SecureField("PIN", text: $pin).keyboardType(.numberPad)
                        .focused($pinFocused).accessibilityIdentifier("identityUnlockPIN")
                    Button("Unlock identity") {
                        model.perform { try $0.unlock(pin: pin) }
                        pin = ""
                        if model.unlocked { done() }
                    }.disabled(pin.isEmpty).accessibilityIdentifier("identityUnlockButton")
                    if let notice = model.notice { Text(notice) }
                }
            }.navigationTitle("Unlock identity")
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Continue locked") { pin = ""; done() } } }
        }.onAppear { pinFocused = true }
            .onDisappear { pin = "" }
            .onChange(of: scenePhase) { _, phase in if phase != .active { pin = "" } }
    }
}
