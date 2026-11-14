document.querySelectorAll('[data-text-color]').forEach(element => {
	element.style.color = element.dataset.textColor;
});

document.querySelectorAll('[data-border-left-color]').forEach(element => {
	element.style.borderLeftColor = element.dataset.borderLeftColor;
});
