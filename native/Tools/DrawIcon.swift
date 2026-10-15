import AppKit
let path = CommandLine.arguments[1]
let image = NSImage(size:NSSize(width:1024,height:1024))
image.lockFocus()
NSColor(calibratedRed:0.10,green:0.21,blue:0.31,alpha:1).setFill(); NSBezierPath(rect:NSRect(x:0,y:0,width:1024,height:1024)).fill()
NSColor(calibratedRed:0.94,green:0.97,blue:0.96,alpha:1).setFill(); NSBezierPath(roundedRect:NSRect(x:234,y:158,width:556,height:708),xRadius:38,yRadius:38).fill()
NSColor(calibratedRed:0.12,green:0.47,blue:0.47,alpha:1).setStroke()
for (y,width) in [(678,352),(558,352),(438,352),(318,208)] {
    let line = NSBezierPath(); line.lineWidth = 28; line.lineCapStyle = .round; line.move(to:NSPoint(x:336,y:y)); line.line(to:NSPoint(x:336+width,y:y)); line.stroke()
}
image.unlockFocus()
let bitmap = NSBitmapImageRep(data:image.tiffRepresentation!)!
try bitmap.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:path))
