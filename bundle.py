import os
import re

# Config
SOURCE_DIR = r"c:\Source\auto-painter\src"
OUTPUT_FILE = r"c:\Source\auto-painter\wplace_painter.user.js"


# File Order (Dependency First)
formatted_order = [
    "utils.js",
    "wasmToken.js",
    "Template.js",
    "Overlay.js",
    "observers.js",
    "templateManager.js",
    "apiManager.js",
    "main.js"
]

# Metadata Block
HEADER = """// ==UserScript==
// @name         BM Auto-Painter
// @namespace    https://wplace.live/
// @version      2.0.2
// @description  Automated pixel painting with WASM token generation.
// @author       SwingTheVine & Refactored by 3eck
// @match        https://wplace.live/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=wplace.live
// @grant        GM_addStyle
// @grant        GM_getResourceText
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_info
// @grant        unsafeWindow
// @resource     CSS-BM-File https://raw.githubusercontent.com/3eck/auto-painter/main/src/overlay.css
// ==/UserScript==

(function() {
    'use strict';
    console.log("BM Auto-Painter Script Starting...");

"""

FOOTER = """
})();
"""

def clean_content(content, filename):
    lines = content.split('\n') # Input is standard string, so \n is correct
    cleaned_lines = []
    
    for line in lines:
        # Skip Imports
        if re.match(r'^\s*import\s+', line):
            continue
            
        # Remove "export default "
        line = re.sub(r'^\s*export\s+default\s+', '', line)
        
        # Remove "export " from declarations (e.g. export class, export function, export const)
        # We use a lookahead to ensure we only strip export when followed by a declaration
        line = re.sub(r'^\s*export\s+(?=(async\s+)?(function|class|const|let|var)\b)', '', line)

        # Remove "export { ... }" lines entirely (named exports)
        if re.match(r'^\s*export\s*\{', line):
            continue
            
        cleaned_lines.append(line)
        
    return "\n".join(cleaned_lines)

def bundle():
    print(f"Bundling to {OUTPUT_FILE}...")
    
    full_content = HEADER
    
    for filename in formatted_order:
        path = os.path.join(SOURCE_DIR, filename)
        if os.path.exists(path):
            print(f"Processing {filename}...")
            with open(path, 'r', encoding='utf-8') as f:
                content = f.read()
                
            # Add section header
            full_content += f"\n\n// ==================== {filename} ====================\n"
            full_content += clean_content(content, filename)
        else:
            print(f"WARNING: Missing {filename}")
            
    full_content += FOOTER
    
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        f.write(full_content)
        
    print("Done!")

if __name__ == "__main__":
    bundle()
