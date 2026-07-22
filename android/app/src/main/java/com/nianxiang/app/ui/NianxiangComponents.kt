package com.nianxiang.app.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

object NxColors {
    val Ink = Color(0xFF060605)
    val InkWarm = Color(0xFF0C0A07)
    val Panel = Color(0xB316161A)
    val PanelSolid = Color(0xF216161A)
    val Control = Color(0xBF1C1C21)
    val ControlRaised = Color(0xCC303037)
    val Text = Color(0xEBFFFFFF)
    val TextDim = Color(0x8CFFFFFF)
    val TextFaint = Color(0x52FFFFFF)
    val Line = Color(0x24FFFFFF)
    val LineStrong = Color(0x42FFFFFF)
    val Paper = Color(0xFFF1F0ED)
    val OnPaper = Color(0xFF171717)
    val Gold = Color(0xFFE8C48A)
    val Rose = Color(0xFFD98F98)
    val Blue = Color(0xFF86A8C8)
    val Green = Color(0xFF82AE94)
    val Error = Color(0xFFFF8E8E)
}

val NxSerif = FontFamily.Serif

@Composable
fun NxBackdrop(modifier: Modifier = Modifier, content: @Composable BoxScope.() -> Unit) {
    Box(
        modifier
            .fillMaxSize()
            .background(
                Brush.radialGradient(
                    colors = listOf(
                        NxColors.InkWarm.copy(alpha = 0.92f),
                        NxColors.Ink.copy(alpha = 0.9f),
                        Color.Black.copy(alpha = 0.94f),
                    ),
                    radius = 1500f,
                ),
            ),
    ) {
        content()
    }
}

@Composable
fun NxField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    singleLine: Boolean = true,
    password: Boolean = false,
    leadingIcon: ImageVector? = null,
    enabled: Boolean = true,
    maxLength: Int? = null,
) {
    BasicTextField(
        value = value,
        onValueChange = { next ->
            onValueChange(if (maxLength != null) next.take(maxLength) else next)
        },
        modifier = modifier
            .heightIn(min = 42.dp)
            .background(NxColors.Control, RoundedCornerShape(8.dp))
            .border(1.dp, NxColors.Line, RoundedCornerShape(8.dp))
            .padding(horizontal = 14.dp, vertical = 9.dp),
        enabled = enabled,
        singleLine = singleLine,
        textStyle = TextStyle(color = NxColors.Text, fontSize = 13.sp),
        cursorBrush = SolidColor(NxColors.Paper),
        visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
        decorationBox = { inner ->
            Row(
                verticalAlignment = if (singleLine) Alignment.CenterVertically else Alignment.Top,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                if (leadingIcon != null) {
                    Icon(leadingIcon, null, tint = NxColors.TextFaint, modifier = Modifier.size(18.dp))
                }
                Box(Modifier.weight(1f)) {
                    if (value.isEmpty()) Text(placeholder, color = NxColors.TextFaint, fontSize = 13.sp)
                    inner()
                }
            }
        },
    )
}

@Composable
fun NxSearchField(value: String, onValueChange: (String) -> Unit, modifier: Modifier = Modifier) {
    NxField(
        value = value,
        onValueChange = onValueChange,
        placeholder = "搜索记忆 · 对话 · 日记",
        modifier = modifier,
        leadingIcon = Icons.Default.Search,
    )
}

@Composable
fun NxPill(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    selected: Boolean = false,
    enabled: Boolean = true,
    icon: ImageVector? = null,
) {
    Surface(
        onClick = onClick,
        modifier = modifier.defaultMinSize(minHeight = 38.dp),
        enabled = enabled,
        shape = RoundedCornerShape(50),
        color = when {
            selected -> NxColors.Paper
            else -> NxColors.Control
        },
        contentColor = if (selected) NxColors.OnPaper else NxColors.TextDim,
        border = BorderStroke(1.dp, if (selected) NxColors.Paper else NxColors.Line),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp),
        ) {
            if (icon != null) Icon(icon, null, modifier = Modifier.size(15.dp))
            Text(text, fontSize = 12.5.sp)
        }
    }
}

/** 暖金描边 + 光晕的凝聚按钮，对齐 Web 的 .condense-btn。 */
@Composable
fun CondenseButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    Surface(
        onClick = onClick,
        modifier = modifier.defaultMinSize(minHeight = 42.dp),
        enabled = enabled,
        shape = RoundedCornerShape(50),
        color = Color(0xCC1E1D1A),
        contentColor = Color(0xF2FFEAC8),
        border = BorderStroke(1.dp, Color(0x47FFE0B2)),
        shadowElevation = 6.dp,
    ) {
        Text(
            text,
            fontSize = 13.5.sp,
            modifier = Modifier.padding(horizontal = 24.dp, vertical = 11.dp),
        )
    }
}

@Composable
fun NxIconButton(
    icon: ImageVector,
    contentDescription: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    selected: Boolean = false,
    enabled: Boolean = true,
) {
    Surface(
        onClick = onClick,
        modifier = modifier.size(38.dp),
        enabled = enabled,
        shape = CircleShape,
        color = if (selected) NxColors.Paper else NxColors.Control,
        contentColor = if (selected) NxColors.OnPaper else NxColors.TextDim,
        border = BorderStroke(1.dp, if (selected) NxColors.Paper else NxColors.Line),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription, modifier = Modifier.size(17.dp))
        }
    }
}

@Composable
fun NxPanel(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Box(
        modifier
            .background(NxColors.Panel, RoundedCornerShape(8.dp))
            .border(1.dp, NxColors.Line, RoundedCornerShape(8.dp)),
    ) {
        content()
    }
}

@Composable
fun NxPageTitle(title: String, modifier: Modifier = Modifier, subtitle: String? = null) {
    androidx.compose.foundation.layout.Column(modifier) {
        Text(
            title,
            color = NxColors.Text,
            style = MaterialTheme.typography.headlineMedium,
            fontFamily = NxSerif,
        )
        if (!subtitle.isNullOrBlank()) {
            Text(subtitle, color = NxColors.TextDim, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp))
        }
    }
}

@Composable
fun NxSegmentedControl(
    options: List<Pair<String, String>>,
    selected: String,
    onSelected: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(
        modifier = modifier,
        color = NxColors.Control,
        shape = RoundedCornerShape(50),
        border = BorderStroke(1.dp, NxColors.Line),
    ) {
        Row(Modifier.padding(4.dp)) {
            options.forEach { (key, label) ->
                Surface(
                    onClick = { onSelected(key) },
                    color = if (selected == key) NxColors.Paper else Color.Transparent,
                    contentColor = if (selected == key) NxColors.OnPaper else NxColors.TextFaint,
                    shape = RoundedCornerShape(50),
                ) {
                    Text(
                        label,
                        fontSize = 13.sp,
                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 7.dp),
                    )
                }
            }
        }
    }
}

@Composable
fun NxPrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    NxPill(
        text = text,
        onClick = onClick,
        modifier = modifier.fillMaxWidth(),
        selected = true,
        enabled = enabled,
    )
}
