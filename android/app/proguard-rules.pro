# Nianxiang R8 rules

# ---- kotlinx.serialization（官方规则）----
# 保留 @Serializable 类的序列化器入口，避免 R8 裁掉反射查找的 serializer()/Companion。
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**

-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# 本应用的 @Serializable 模型（data/Models.kt 等）
-keep,includedescriptorclasses class com.nianxiang.app.**$$serializer { *; }
-keepclassmembers class com.nianxiang.app.** {
    *** Companion;
}
-keepclasseswithmembers class com.nianxiang.app.** {
    kotlinx.serialization.KSerializer serializer(...);
}

# ---- Ktor / SLF4J ----
# ktor-client 在 JVM 平台引用 slf4j 与部分桌面专用类，Android 上不存在，仅需消除告警。
-dontwarn org.slf4j.**
-dontwarn io.ktor.**
-dontwarn java.lang.management.**

# ---- kotlinx.coroutines ----
-dontwarn kotlinx.coroutines.debug.**
