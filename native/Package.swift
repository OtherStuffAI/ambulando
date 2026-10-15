// swift-tools-version: 5.9
import PackageDescription
let package = Package(name:"NoteToSelf", platforms:[.macOS(.v14)], dependencies:[.package(url:"https://github.com/21-DOT-DEV/swift-secp256k1",exact:"0.23.2")],targets:[
    .target(name:"NoteCore",dependencies:[.product(name:"P256K",package:"swift-secp256k1")],path:"NoteToSelf",exclude:["NoteToSelfApp.swift","IdentitySettings.swift","Assets.xcassets"],sources:["Models.swift","Privacy.swift","IdentityVault.swift","NostrSigning.swift","NStackAPI.swift","NoteStore.swift"]),
    .testTarget(name:"NoteTests",dependencies:["NoteCore"],path:"Tests")
])
