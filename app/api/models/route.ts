import { NextResponse } from "next/server";

export async function GET() {
  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return NextResponse.json({ error: "Chưa cấu hình GEMINI_API_KEY" }, { status: 500 });
    }

    // Gọi API ListModels của Google
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const data = await response.json();

    // Lọc ra các model hỗ trợ generateContent để dễ nhìn
    const supportedModels = data.models
      ?.filter((m: any) => m.supportedGenerationMethods?.includes("generateContent"))
      ?.map((m: any) => ({
        name: m.name.replace("models/", ""), // Tên model để điền vào code
        displayName: m.displayName,
        version: m.version
      }));

    return NextResponse.json({ 
      total: supportedModels?.length || 0,
      available_models: supportedModels 
    });

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}