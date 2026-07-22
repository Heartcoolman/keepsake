package com.nianxiang.app.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.sp

private val scheme = darkColorScheme(
    primary = NxColors.Paper,
    onPrimary = NxColors.OnPaper,
    background = NxColors.Ink,
    surface = NxColors.PanelSolid,
    surfaceVariant = NxColors.ControlRaised,
    onBackground = NxColors.Text,
    onSurface = NxColors.Text,
    onSurfaceVariant = NxColors.TextDim,
    secondary = NxColors.Blue,
    error = NxColors.Error,
)

private val typography = Typography(
    displayLarge = TextStyle(fontFamily = FontFamily.Serif, fontSize = 42.sp, lineHeight = 50.sp),
    headlineLarge = TextStyle(fontFamily = FontFamily.Serif, fontSize = 32.sp, lineHeight = 40.sp),
    headlineMedium = TextStyle(fontFamily = FontFamily.Serif, fontSize = 25.sp, lineHeight = 32.sp),
    titleLarge = TextStyle(fontFamily = FontFamily.Serif, fontSize = 21.sp, lineHeight = 28.sp),
    titleMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 17.sp, lineHeight = 23.sp),
    bodyLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 16.sp, lineHeight = 25.sp),
    bodyMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 14.sp, lineHeight = 22.sp),
    labelLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 14.sp, lineHeight = 20.sp),
)

@Composable
fun NianxiangTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, typography = typography, content = content)
}
